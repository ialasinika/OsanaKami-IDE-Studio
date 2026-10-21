// Write-ahead log: append-only encrypted records (see 06-database §2/§7 and
// 07-encryption §4).
#pragma once

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "core/util.h"
#include "db/keys.h"

namespace iaqs::db {

enum class WalRecordType : uint8_t { Begin = 1, Page = 2, Commit = 3, Rollback = 4 };

struct WalRecord {
  uint64_t lsn;
  WalRecordType type;
  Bytes payload;
};

// Appends encrypted records to <dir>/wal-NNNNNN.log.
//
// On-disk format (little endian):
//   [u32 total_len][u32 crc32c][u64 lsn][u8 type][ciphertext]
// where total_len counts the bytes after itself (8 + 1 + ciphertext.size()),
// crc32c covers lsn || type || ciphertext, and ciphertext is the AEAD output
// (payload || 16B tag). The nonce is epoch u32 || wal_seg_id u32 ||
// low32(lsn) u32; the AAD is lsn u64.
class WalWriter {
 public:
  // Creates `dir` when missing and opens (or creates) the segment file for
  // append. Throws std::runtime_error on failure.
  WalWriter(const std::string& dir, uint32_t wal_seg_id, Key32 wal_key,
            uint32_t epoch, uint64_t first_lsn, bool encrypted = true);
  ~WalWriter();

  WalWriter(const WalWriter&) = delete;
  WalWriter& operator=(const WalWriter&) = delete;

  // Seals and appends one record; returns its LSN and bumps the internal
  // counter. Throws std::runtime_error when the record cannot be written.
  uint64_t append(WalRecordType type, ByteSpan payload);

  // Flushes stdio buffers and fsyncs the segment file.
  void sync();

  uint64_t next_lsn() const { return next_lsn_; }

 private:
  void write_all(const Bytes& record);

  std::string dir_;
  std::string path_;
  std::FILE* file_ = nullptr;
  uint32_t wal_seg_id_ = 0;
  Key32 wal_key_{};
  uint32_t epoch_ = 0;
  uint64_t next_lsn_ = 0;
  bool encrypted_ = true;
};

class WalReader {
 public:
  // Reads every complete record from wal-*.log files in `dir`, ordered by file
  // name and by position within each file. A truncated record at the end of a
  // segment (too few bytes left, or total_len beyond the file remainder) stops
  // that segment silently; a complete record that fails CRC or AEAD
  // verification throws std::runtime_error. A missing/empty directory yields
  // an empty vector. Recovery passes tolerate_tail=true: a damaged record at
  // the tail of the newest segment is treated as end-of-log (a crash artefact)
  // instead of making the database unopenable; strict readers keep the error.
  static std::vector<WalRecord> read_all(const std::string& dir,
                                         const Key32& wal_key, uint32_t epoch,
                                         bool tolerate_tail = false,
                                         bool encrypted = true);
};

}  // namespace iaqs::db
