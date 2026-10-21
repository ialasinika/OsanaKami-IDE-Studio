// A segment is a plain, fixed-slot file: seg-<6 digits>.dat. Slots are
// plaintext page envelopes (see db/envelope.h). Page 0 of every segment is
// its SegmentHeader page; data pages start at 1.
#pragma once

#include <cstdint>
#include <fstream>
#include <string>

#include "core/util.h"

namespace iaqs::db {

class SegmentFile {
 public:
  static std::string path_for(const std::string& dir, uint32_t seg_id);

  // Opens an existing segment file. `page_count` is derived from the file
  // size; a trailing partial slot (crash during append) is ignored.
  static SegmentFile open(const std::string& dir, uint32_t seg_id,
                          uint32_t page_size);

  // Creates (or truncates) a segment file.
  static SegmentFile create(const std::string& dir, uint32_t seg_id,
                            uint32_t page_size);

  SegmentFile(SegmentFile&& other) noexcept = default;
  SegmentFile& operator=(SegmentFile&& other) noexcept = default;
  SegmentFile(const SegmentFile&) = delete;
  SegmentFile& operator=(const SegmentFile&) = delete;

  uint32_t seg_id() const { return seg_id_; }
  uint32_t page_size() const { return page_size_; }
  uint32_t page_count() const { return page_count_; }
  const std::string& path() const { return path_; }

  // Reads a full slot; throws std::runtime_error on out-of-range or I/O error.
  Bytes read_slot(uint32_t page_no);

  // Writes a full slot, extending the file when page_no == page_count().
  // Throws std::runtime_error on I/O error.
  void write_slot(uint32_t page_no, ByteSpan slot);

  // Flushes user-space buffers to the OS (durability to media is the WAL's
  // job; see docs/design/06-database.md).
  void sync();

  void refresh_page_count();

 private:
  SegmentFile(std::string dir, uint32_t seg_id, uint32_t page_size,
              std::fstream file);

  std::string dir_;
  std::string path_;
  uint32_t seg_id_ = 0;
  uint32_t page_size_ = 0;
  uint32_t page_count_ = 0;
  std::fstream file_;
};

}  // namespace iaqs::db
