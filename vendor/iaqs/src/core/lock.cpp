#include "core/lock.h"

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <stdexcept>
#include <string>

#include "core/util.h"

#ifdef _WIN32
#include <windows.h>
#else
#include <csignal>
#include <fcntl.h>
#include <unistd.h>
#endif

namespace iaqs {
namespace {

namespace fs = std::filesystem;

fs::path to_path(const std::string& text) {
  const std::u8string u8(reinterpret_cast<const char8_t*>(text.data()), text.size());
  return fs::path(u8);
}

int64_t current_pid() {
#ifdef _WIN32
  return static_cast<int64_t>(GetCurrentProcessId());
#else
  return static_cast<int64_t>(getpid());
#endif
}

bool process_alive(int64_t pid) {
  if (pid <= 0) return false;
#ifdef _WIN32
  HANDLE handle =
      OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, static_cast<DWORD>(pid));
  if (handle == nullptr) return false;
  CloseHandle(handle);
  return true;
#else
  return kill(static_cast<pid_t>(pid), 0) == 0;
#endif
}

// Atomically creates the lock file. Returns false when it already exists.
bool create_exclusive(const std::string& path) {
#ifdef _WIN32
  HANDLE handle = CreateFileW(to_path(path).c_str(), GENERIC_WRITE, 0, nullptr,
                              CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (handle == INVALID_HANDLE_VALUE) return false;
  CloseHandle(handle);
  return true;
#else
  const int fd = open(path.c_str(), O_CREAT | O_EXCL | O_WRONLY, 0600);
  if (fd < 0) return false;
  close(fd);
  return true;
#endif
}

struct LockInfo {
  int64_t pid = 0;
  int64_t time = 0;
};

bool parse_lock(const std::string& content, LockInfo& info) {
  const std::size_t pid_pos = content.find("pid ");
  const std::size_t time_pos = content.find("time ");
  if (pid_pos == std::string::npos || time_pos == std::string::npos) return false;
  try {
    info.pid = std::stoll(content.substr(pid_pos + 4));
    info.time = std::stoll(content.substr(time_pos + 5));
  } catch (...) {
    return false;
  }
  return true;
}

// Removes a lock whose owner is dead (or whose content is unreadable). The
// create-then-write window must not be mistaken for garbage, so an unparsable
// lock is only treated as stale after a few seconds. Liveness wins over age: a
// long-running import must never be stolen just because it is old.
bool remove_if_stale(const std::string& path) {
  std::string content;
  try {
    content = read_file(path);
  } catch (...) {
    return true;  // vanished already
  }
  LockInfo info;
  const bool parsed = parse_lock(content, info);
  bool stale = false;
  if (!parsed) {
    if (!content.empty()) {
      // Non-empty garbage can never come from the create-then-write window:
      // whatever wrote it is not an iaqs lock owner.
      stale = true;
    } else {
      std::error_code ec;
      const auto modified = std::filesystem::last_write_time(path, ec);
      if (ec) return true;
      // Fresh but empty: the owner may be between create and write.
      const auto now_fs = std::filesystem::file_time_type::clock::now();
      stale = (now_fs - modified) > std::chrono::seconds(2);
    }
  } else {
    const int64_t now = static_cast<int64_t>(std::time(nullptr));
    // Absurd/future timestamps are garbage, not a live writer.
    stale = info.pid <= 0 || info.time <= 0 || info.time > now + 300 ||
            !process_alive(info.pid);
  }
  if (!stale) return false;
  try {
    remove_file(path);
  } catch (...) {
    return false;
  }
  return true;
}

}  // namespace

FileLock::~FileLock() { release(); }

FileLock::FileLock(FileLock&& other) noexcept
    : path_(std::move(other.path_)), held_(other.held_) {
  other.held_ = false;
  other.path_.clear();
}

FileLock& FileLock::operator=(FileLock&& other) noexcept {
  if (this != &other) {
    release();
    path_ = std::move(other.path_);
    held_ = other.held_;
    other.held_ = false;
    other.path_.clear();
  }
  return *this;
}

FileLock FileLock::acquire(const std::string& path) {
  for (int attempt = 0; attempt < 3; ++attempt) {
    if (create_exclusive(path)) {
      FileLock lock;
      lock.path_ = path;
      lock.held_ = true;
      const std::string content = "pid " + std::to_string(current_pid()) + "\ntime " +
                                  std::to_string(std::time(nullptr)) + "\n";
      write_file(path, bytes_span(content));
      return lock;
    }
    if (!remove_if_stale(path)) break;
  }
  throw std::runtime_error(
      "repository is locked by another process (delete " + path +
      " only if no other iaqs is running)");
}

FileLock FileLock::acquire_wait(const std::string& path, int timeout_ms, int poll_ms) {
  const auto deadline = std::chrono::steady_clock::now() +
                        std::chrono::milliseconds(timeout_ms < 0 ? 0 : timeout_ms);
  for (;;) {
    for (int attempt = 0; attempt < 3; ++attempt) {
      if (create_exclusive(path)) {
        FileLock lock;
        lock.path_ = path;
        lock.held_ = true;
        const std::string content = "pid " + std::to_string(current_pid()) + "\ntime " +
                                    std::to_string(std::time(nullptr)) + "\n";
        write_file(path, bytes_span(content));
        return lock;
      }
      if (!remove_if_stale(path)) break;
    }
    if (std::chrono::steady_clock::now() >= deadline) break;
#ifdef _WIN32
    Sleep(static_cast<DWORD>(poll_ms > 0 ? poll_ms : 1));
#else
    struct timespec ts;
    ts.tv_sec = 0;
    ts.tv_nsec = static_cast<long>(poll_ms > 0 ? poll_ms : 1) * 1000000L;
    nanosleep(&ts, nullptr);
#endif
  }
  throw std::runtime_error(
      "repository is locked by another process (delete " + path +
      " only if no other iaqs is running)");
}

void FileLock::release() {
  if (!held_) return;
  held_ = false;
  try {
    remove_file(path_);
  } catch (...) {
    // Best effort: a leftover lock is reclaimed as stale later.
  }
}

}  // namespace iaqs
