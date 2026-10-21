// The plaintext store this project creates: no password, checksummed pages,
// and a manifest that names the format instead of a key mode.
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>

#include "../harness.h"
#include "db/database.h"
#include "db/manifest.h"
#include "db/row.h"
#include "vcs/repo.h"

namespace {

namespace fs = std::filesystem;
using namespace iaqs;
using namespace iaqs::db;

std::string unique_suffix() {
  static std::atomic<uint64_t> counter{0};
  const auto now = std::chrono::steady_clock::now().time_since_epoch().count();
  return std::to_string(now) + "-" + std::to_string(counter++);
}

class TestDir {
 public:
  explicit TestDir(const char* name)
      : path_(fs::temp_directory_path() /
              ("iaqs-plain-" + std::string(name) + "-" + unique_suffix())) {}
  ~TestDir() {
    std::error_code ec;
    fs::remove_all(path_, ec);
  }
  TestDir(const TestDir&) = delete;
  TestDir& operator=(const TestDir&) = delete;
  std::string path() const { return path_.string(); }

 private:
  fs::path path_;
};

TableSchema notes_schema() {
  TableSchema schema;
  schema.name = "notes";
  schema.columns = {
      ColumnDef{"id", ValueType::Integer, true, true},
      ColumnDef{"body", ValueType::Text, false, true},
  };
  return schema;
}

// True when `needle` appears in any file under `dir` (the store keeps pages and
// the WAL on disk; a plaintext body must be readable there).
bool stored_somewhere(const std::string& dir, const std::string& needle) {
  std::error_code ec;
  for (const auto& entry : fs::recursive_directory_iterator(fs::path(dir), ec)) {
    if (!entry.is_regular_file()) continue;
    const auto size = entry.file_size();
    if (size == 0) continue;
    std::string data(static_cast<size_t>(size), '\0');
    std::FILE* f = std::fopen(entry.path().string().c_str(), "rb");
    if (f == nullptr) continue;
    const size_t got = std::fread(data.data(), 1, data.size(), f);
    std::fclose(f);
    data.resize(got);
    if (data.find(needle) != std::string::npos) return true;
  }
  return false;
}

// A format-1 manifest, which named a password-derived key mode. This build has
// no such mode and must refuse the database instead of misreading it.
void write_legacy_manifest(const std::string& dir) {
  std::string bytes(153, '\0');
  std::memcpy(bytes.data(), "IAQSDB1", 8);
  uint8_t* p = reinterpret_cast<uint8_t*>(bytes.data());
  store_u32_le(p + 8, 1);
  store_u32_le(p + 12, 8192);
  store_u64_le(p + 16, 16ull * 1024 * 1024);
  p[40] = 1;
  std::error_code ec;
  fs::create_directories(fs::path(dir), ec);
  std::ofstream out(fs::path(dir) / "MANIFEST", std::ios::binary | std::ios::trunc);
  out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}

}  // namespace

IAQS_TEST(plain_store, round_trip_without_a_password) {
  TestDir dir("roundtrip");
  {
    Database db = Database::create(dir.path());
    CHECK_EQ(db.manifest().format_version, kManifestFormatVersion);
    db.create_table(notes_schema());
    Row row;
    row.values = {Value::integer(1), Value::text("plaintext-marker-4030")};
    db.insert_row("notes", row);
  }
  {
    Database db = Database::open(dir.path());
    const auto rows = db.scan_rows("notes");
    CHECK(rows.size() == 1);
    CHECK(rows[0].second.values[1].bytes == "plaintext-marker-4030");
  }
}

IAQS_TEST(plain_store, bodies_are_readable_on_disk) {
  TestDir dir("on-disk");
  {
    Database db = Database::create(dir.path());
    db.create_table(notes_schema());
    Row row;
    row.values = {Value::integer(7), Value::text("visible-in-the-file-9182")};
    db.insert_row("notes", row);
    db.checkpoint();
  }
  CHECK(stored_somewhere(dir.path(), "visible-in-the-file-9182"));
}

IAQS_TEST(plain_store, refuses_a_manifest_that_names_a_removed_password_mode) {
  TestDir dir("legacy");
  write_legacy_manifest(dir.path());
  bool explained = false;
  try {
    Database::open(dir.path());
  } catch (const std::runtime_error& error) {
    explained = std::string(error.what()).find("password mode") != std::string::npos;
  }
  CHECK(explained);
}

IAQS_TEST(plain_store, a_repository_initialises_without_a_password) {
  TestDir dir("repo");
  {
    vcs::Repo repo = vcs::Repo::init(fs::path(dir.path()));
    CHECK_EQ(repo.database().manifest().format_version, kManifestFormatVersion);
    repo.database().close();
  }
  vcs::Repo reopened = vcs::Repo::open(fs::path(dir.path()));
  CHECK_EQ(reopened.database().manifest().format_version, kManifestFormatVersion);
  reopened.database().close();
}
