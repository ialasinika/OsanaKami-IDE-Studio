// Cross-process exclusive lock file used to keep a database single-writer.
#pragma once

#include <string>

namespace iaqs {

// A lock file at `path` containing "pid <n>\ntime <unix>\n". Acquisition is
// exclusive (atomic create). A lock whose owner is gone or older than one hour
// is treated as stale and reclaimed.
class FileLock {
 public:
  FileLock() = default;
  ~FileLock();

  FileLock(const FileLock&) = delete;
  FileLock& operator=(const FileLock&) = delete;
  FileLock(FileLock&& other) noexcept;
  FileLock& operator=(FileLock&& other) noexcept;

  // Throws std::runtime_error when a live process holds the lock.
  static FileLock acquire(const std::string& path);

  // Like acquire(), but waits for the current holder to release, polling every
  // `poll_ms` until `timeout_ms` elapses. Throws on timeout.
  static FileLock acquire_wait(const std::string& path, int timeout_ms = 30000,
                               int poll_ms = 10);

  bool held() const { return held_; }
  void release();

 private:
  std::string path_;
  bool held_ = false;
};

}  // namespace iaqs
