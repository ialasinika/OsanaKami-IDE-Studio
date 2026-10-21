#include <cstdio>
#include <filesystem>
#include <random>
#include <stdexcept>
#include <string>

#include "core/lock.h"
#include "core/util.h"
#include "harness.h"

using namespace iaqs;

namespace {

namespace fs = std::filesystem;

struct TempDir {
  fs::path path;
  TempDir() {
    std::random_device rd;
    char suffix[32];
    std::snprintf(suffix, sizeof(suffix), "iaqs-lock-%08x", rd());
    path = fs::temp_directory_path() / suffix;
    fs::create_directories(path);
  }
  ~TempDir() {
    std::error_code ec;
    fs::remove_all(path, ec);
  }
};

}  // namespace

IAQS_TEST(lock, exclusive_acquisition) {
  TempDir tmp;
  const std::string lock_path = (tmp.path / "locked").string();
  FileLock first = FileLock::acquire(lock_path);
  CHECK(first.held());
  CHECK_THROW(FileLock::acquire(lock_path), std::runtime_error);
  first.release();
  CHECK(!first.held());
  FileLock again = FileLock::acquire(lock_path);
  CHECK(again.held());
}

IAQS_TEST(lock, stale_lock_is_reclaimed) {
  TempDir tmp;
  const std::string lock_path = (tmp.path / "locked").string();
  write_file(lock_path, bytes_span(std::string("pid 999999999\ntime 1\n")));
  FileLock lock = FileLock::acquire(lock_path);
  CHECK(lock.held());
}

IAQS_TEST(lock, garbage_lock_is_stale) {
  TempDir tmp;
  const std::string lock_path = (tmp.path / "locked").string();
  write_file(lock_path, bytes_span(std::string("not a lock\n")));
  FileLock lock = FileLock::acquire(lock_path);
  CHECK(lock.held());
}
