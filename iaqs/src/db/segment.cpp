#include "db/segment.h"

#include <cstdio>
#include <stdexcept>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

#include "core/util.h"

namespace iaqs::db {
namespace {

std::string format_segment_name(uint32_t seg_id) {
  char buf[32];
  std::snprintf(buf, sizeof buf, "seg-%06u.dat", seg_id);
  return std::string(buf);
}

}  // namespace

std::string SegmentFile::path_for(const std::string& dir, uint32_t seg_id) {
  return dir + "/" + format_segment_name(seg_id);
}

SegmentFile::SegmentFile(std::string dir, uint32_t seg_id, uint32_t page_size,
                         std::fstream file)
    : dir_(std::move(dir)),
      path_(path_for(dir_, seg_id)),
      seg_id_(seg_id),
      page_size_(page_size),
      file_(std::move(file)) {}

SegmentFile SegmentFile::open(const std::string& dir, uint32_t seg_id,
                              uint32_t page_size) {
  if (page_size == 0) throw std::runtime_error("SegmentFile: page_size is zero");
  const std::string path = path_for(dir, seg_id);
  std::fstream file(fs_path_from_utf8(path),
                    std::ios::in | std::ios::out | std::ios::binary);
  if (!file) {
    throw std::runtime_error("SegmentFile: cannot open " + path);
  }
  SegmentFile seg(dir, seg_id, page_size, std::move(file));
  seg.refresh_page_count();
  return seg;
}

SegmentFile SegmentFile::create(const std::string& dir, uint32_t seg_id,
                                uint32_t page_size) {
  if (page_size == 0) throw std::runtime_error("SegmentFile: page_size is zero");
  const std::string path = path_for(dir, seg_id);
  std::fstream file(fs_path_from_utf8(path),
                    std::ios::in | std::ios::out | std::ios::binary | std::ios::trunc);
  if (!file) {
    throw std::runtime_error("SegmentFile: cannot create " + path);
  }
  SegmentFile seg(dir, seg_id, page_size, std::move(file));
  seg.page_count_ = 0;
  return seg;
}

void SegmentFile::refresh_page_count() {
  file_.clear();
  file_.seekg(0, std::ios::end);
  const std::streamoff size = file_.tellg();
  if (size < 0) throw std::runtime_error("SegmentFile: tellg failed on " + path_);
  page_count_ = static_cast<uint32_t>(size / page_size_);
}

Bytes SegmentFile::read_slot(uint32_t page_no) {
  if (page_no >= page_count_) {
    throw std::runtime_error("SegmentFile: page out of range");
  }
  Bytes slot(page_size_, '\0');
  file_.clear();
  file_.seekg(static_cast<std::streamoff>(page_no) * page_size_, std::ios::beg);
  file_.read(slot.data(), static_cast<std::streamsize>(page_size_));
  if (!file_ || file_.gcount() != static_cast<std::streamsize>(page_size_)) {
    throw std::runtime_error("SegmentFile: short read in " + path_);
  }
  return slot;
}

void SegmentFile::write_slot(uint32_t page_no, ByteSpan slot) {
  if (slot.size() != page_size_) {
    throw std::runtime_error("SegmentFile: slot has wrong size");
  }
  if (page_no > page_count_) {
    // Fill any gap with zeroed slots so the file stays dense.
    Bytes zero(page_size_, '\0');
    file_.clear();
    file_.seekp(0, std::ios::end);
    for (uint32_t p = page_count_; p < page_no; ++p) {
      file_.write(zero.data(), static_cast<std::streamsize>(page_size_));
    }
  }
  file_.clear();
  file_.seekp(static_cast<std::streamoff>(page_no) * page_size_, std::ios::beg);
  file_.write(reinterpret_cast<const char*>(slot.data()),
              static_cast<std::streamsize>(slot.size()));
  if (!file_) throw std::runtime_error("SegmentFile: write failed in " + path_);
  if (page_no >= page_count_) page_count_ = page_no + 1;
  file_.flush();
  if (!file_) throw std::runtime_error("SegmentFile: flush failed in " + path_);
}

void SegmentFile::sync() {
  file_.flush();
  if (!file_) throw std::runtime_error("SegmentFile: sync failed in " + path_);
  // fflush only reaches the OS cache; the WAL is deleted right after a
  // checkpoint, so the pages themselves must be durable too.
#if defined(_WIN32)
  HANDLE handle = CreateFileW(fs_path_from_utf8(path_).c_str(),
                              GENERIC_READ | GENERIC_WRITE,
                              FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                              OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (handle != INVALID_HANDLE_VALUE) {
    FlushFileBuffers(handle);
    CloseHandle(handle);
  }
#else
  const int descriptor = ::open(path_.c_str(), O_RDONLY);
  if (descriptor >= 0) {
    ::fsync(descriptor);
    ::close(descriptor);
  }
#endif
}

}  // namespace iaqs::db
