#include "db/wal.h"

#include <algorithm>
#include <cstddef>
#include <cstdio>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "crypto/chacha20poly1305.h"
#include "crypto/crc32c.h"

#ifdef _WIN32
#include <io.h>
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace iaqs::db {
namespace {

namespace fs = std::filesystem;

// [u32 total_len][u32 crc32c] then lsn u64 || type u8 || ciphertext.
constexpr size_t kRecordPrefixSize = 8;
constexpr size_t kRecordMetaSize = 9;  // u64 lsn + u8 type
constexpr size_t kMinRecordSize =
    kRecordPrefixSize + kRecordMetaSize + kAeadTagSize;

// nonce = epoch u32 || wal_seg_id u32 || low32(lsn) u32.
void build_nonce(uint32_t epoch, uint32_t wal_seg_id, uint64_t lsn,
                 uint8_t nonce[12]) {
  store_u32_le(nonce + 0, epoch);
  store_u32_le(nonce + 4, wal_seg_id);
  store_u32_le(nonce + 8, static_cast<uint32_t>(lsn & 0xffffffffull));
}

fs::path path_from_utf8(const std::string& s) {
  return fs::path(std::u8string(reinterpret_cast<const char8_t*>(s.data()),
                                s.size()));
}

std::string narrow_utf8(const fs::path& p) {
  const std::u8string s = p.u8string();
  return std::string(reinterpret_cast<const char*>(s.data()), s.size());
}

#ifdef _WIN32
std::wstring widen_utf8(const std::string& s) {
  if (s.empty()) return std::wstring();
  const int size = static_cast<int>(s.size());
  const int len =
      MultiByteToWideChar(CP_UTF8, 0, s.data(), size, nullptr, 0);
  if (len <= 0) throw std::runtime_error("wal: invalid UTF-8 path");
  std::wstring out(static_cast<size_t>(len), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), size, out.data(), len);
  return out;
}

std::FILE* open_append(const std::string& path) {
  return _wfopen(widen_utf8(path).c_str(), L"ab");
}
#else
std::FILE* open_append(const std::string& path) {
  return std::fopen(path.c_str(), "ab");
}
#endif

std::string join_path(const std::string& dir, const std::string& name) {
  if (dir.empty()) return name;
  if (dir.back() == '/' || dir.back() == '\\') return dir + name;
  return dir + "/" + name;
}

std::string segment_name(uint32_t wal_seg_id) {
  char buffer[32];
  std::snprintf(buffer, sizeof buffer, "wal-%06u.log", wal_seg_id);
  return buffer;
}

bool parse_segment_id(const std::string& name, uint32_t& out) {
  // Shape was filtered to "wal-" + digits + ".log"; parse the digits.
  uint64_t value = 0;
  for (size_t i = 4; i + 4 < name.size(); ++i) {
    const char c = name[i];
    if (c < '0' || c > '9') return false;
    value = value * 10 + static_cast<uint64_t>(c - '0');
    if (value > 0xffffffffull) return false;
  }
  out = static_cast<uint32_t>(value);
  return true;
}

std::vector<std::string> list_segments(const std::string& dir) {
  std::vector<std::string> names;
  std::error_code ec;
  fs::directory_iterator it(path_from_utf8(dir), ec);
  if (ec) return names;
  for (const fs::directory_entry& entry : it) {
    std::error_code entry_ec;
    if (!entry.is_regular_file(entry_ec) || entry_ec) continue;
    const std::string name = narrow_utf8(entry.path().filename());
    if (!starts_with(name, "wal-")) continue;
    if (name.size() < 9) continue;  // "wal-" + >=1 digit + ".log"
    if (name.compare(name.size() - 4, 4, ".log") != 0) continue;
    uint32_t seg = 0;
    if (!parse_segment_id(name, seg)) continue;
    names.push_back(name);
  }
  std::sort(names.begin(), names.end());
  return names;
}

}  // namespace

// ---------------------------------------------------------------- WalWriter

WalWriter::WalWriter(const std::string& dir, uint32_t wal_seg_id,
                     Key32 wal_key, uint32_t epoch, uint64_t first_lsn)
    : dir_(dir),
      path_(join_path(dir, segment_name(wal_seg_id))),
      wal_seg_id_(wal_seg_id),
      wal_key_(wal_key),
      epoch_(epoch),
      next_lsn_(first_lsn) {
  if (!dir_exists(dir_)) make_dirs(dir_);
  file_ = open_append(path_);
  if (file_ == nullptr) {
    throw std::runtime_error("wal: cannot open segment for append: " + path_);
  }
}

WalWriter::~WalWriter() {
  if (file_ != nullptr) {
    std::fclose(file_);
    file_ = nullptr;
  }
}

uint64_t WalWriter::append(WalRecordType type, ByteSpan payload) {
  if (file_ == nullptr) {
    throw std::runtime_error("wal: writer is closed: " + path_);
  }
  const uint64_t lsn = next_lsn_;

  uint8_t nonce[12];
  build_nonce(epoch_, wal_seg_id_, lsn, nonce);
  uint8_t aad[8];
  store_u64_le(aad, lsn);
  const Bytes ciphertext =
      aead_seal(wal_key_.data(), nonce, payload, ByteSpan(aad, sizeof aad));

  if (ciphertext.size() > 0xffffffffull - kRecordMetaSize) {
    throw std::runtime_error("wal: record too large: " + path_);
  }
  const uint32_t total_len =
      static_cast<uint32_t>(kRecordMetaSize + ciphertext.size());

  Bytes record;
  record.reserve(kRecordPrefixSize + total_len);
  append_u32_le(record, total_len);
  append_u32_le(record, 0);  // crc32c placeholder
  append_u64_le(record, lsn);
  record.push_back(static_cast<char>(type));
  record.append(ciphertext);

  // The CRC covers lsn || type || ciphertext (everything after the CRC).
  const uint32_t crc = crc32c(ByteSpan(
      reinterpret_cast<const uint8_t*>(record.data()) + kRecordPrefixSize,
      total_len));
  store_u32_le(reinterpret_cast<uint8_t*>(record.data()) + 4, crc);

  write_all(record);
  next_lsn_ = lsn + 1;
  return lsn;
}

void WalWriter::write_all(const Bytes& record) {
  size_t written = 0;
  while (written < record.size()) {
    const size_t n =
        std::fwrite(record.data() + written, 1, record.size() - written, file_);
    if (n == 0) {
      throw std::runtime_error("wal: write failed: " + path_);
    }
    written += n;
  }
}

void WalWriter::sync() {
  if (file_ == nullptr) {
    throw std::runtime_error("wal: writer is closed: " + path_);
  }
  if (std::fflush(file_) != 0) {
    throw std::runtime_error("wal: flush failed: " + path_);
  }
#ifdef _WIN32
  const int rc = _commit(_fileno(file_));
#else
  const int rc = ::fsync(::fileno(file_));
#endif
  if (rc != 0) {
    throw std::runtime_error("wal: fsync failed: " + path_);
  }
}

// ---------------------------------------------------------------- WalReader

std::vector<WalRecord> WalReader::read_all(const std::string& dir,
                                           const Key32& wal_key,
                                           uint32_t epoch, bool tolerate_tail) {
  std::vector<WalRecord> records;
  if (!dir_exists(dir)) return records;

  const std::vector<std::string> segments = list_segments(dir);
  for (size_t index = 0; index < segments.size(); ++index) {
    const std::string& name = segments[index];
    const bool final_segment = index + 1 == segments.size();
    uint32_t seg = 0;
    if (!parse_segment_id(name, seg)) continue;
    const Bytes data = read_file(join_path(dir, name));
    const uint8_t* base = reinterpret_cast<const uint8_t*>(data.data());
    size_t pos = 0;
    try {
      while (true) {
      if (data.size() - pos < kRecordPrefixSize) break;
      const uint8_t* p = base + pos;
      const uint32_t total_len = load_u32_le(p);
      // A truncated tail is not an error: stop this segment silently.
      if (data.size() - pos - kRecordPrefixSize < total_len) break;
      if (kRecordPrefixSize + total_len < kMinRecordSize) {
        throw std::runtime_error("wal: malformed record length in " + name);
      }
      const uint32_t stored_crc = load_u32_le(p + 4);
      const uint64_t lsn = load_u64_le(p + 8);
      if (crc32c(ByteSpan(p + kRecordPrefixSize, total_len)) != stored_crc) {
        throw std::runtime_error("wal: crc mismatch in " + name + " at byte " +
                                 std::to_string(pos));
      }

      WalRecordType type;
      switch (p[16]) {
        case 1: type = WalRecordType::Begin; break;
        case 2: type = WalRecordType::Page; break;
        case 3: type = WalRecordType::Commit; break;
        case 4: type = WalRecordType::Rollback; break;
        default:
          throw std::runtime_error("wal: unknown record type " +
                                   std::to_string(p[16]) + " in " + name);
      }

      const ByteSpan ciphertext(
          p + kRecordPrefixSize + kRecordMetaSize,
          total_len - kRecordMetaSize);
      uint8_t nonce[12];
      build_nonce(epoch, seg, lsn, nonce);
      uint8_t aad[8];
      store_u64_le(aad, lsn);
      Bytes payload;
      if (!aead_open(wal_key.data(), nonce, ciphertext,
                     ByteSpan(aad, sizeof aad), payload)) {
        throw std::runtime_error("wal: authentication failed in " + name +
                                 " at byte " + std::to_string(pos));
      }

      WalRecord record;
      record.lsn = lsn;
      record.type = type;
      record.payload = std::move(payload);
      records.push_back(std::move(record));
      pos += kRecordPrefixSize + total_len;
      }
    } catch (const std::exception&) {
      // A crash can leave a torn record at the tail of the newest segment.
      // Replay everything before it and treat it as end-of-log when the caller
      // asked for recovery tolerance; a damaged non-final segment always
      // signals real corruption.
      if (tolerate_tail && final_segment) break;
      throw;
    }
  }
  return records;
}

}  // namespace iaqs::db
