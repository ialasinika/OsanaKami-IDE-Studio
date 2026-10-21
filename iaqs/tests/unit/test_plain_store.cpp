// The plaintext store this project creates: no password, checksummed pages,
// and the upstream password-wrapped mode stays available beside it.
#include <atomic>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <string>

#include "../harness.h"
#include "db/database.h"
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

}  // namespace

IAQS_TEST(plain_store, round_trip_without_a_password) {
  TestDir dir("roundtrip");
  {
    Database db = Database::create(dir.path(), "");
    CHECK(db.encrypted() == false);
    db.create_table(notes_schema());
    Row row;
    row.values = {Value::integer(1), Value::text("plaintext-marker-4030")};
    db.insert_row("notes", row);
  }
  {
    Database db = Database::open(dir.path(), "");
    CHECK(db.encrypted() == false);
    const auto rows = db.scan_rows("notes");
    CHECK(rows.size() == 1);
    CHECK(rows[0].second.values[1].bytes == "plaintext-marker-4030");
  }
}

IAQS_TEST(plain_store, bodies_are_readable_on_disk) {
  TestDir dir("on-disk");
  {
    Database db = Database::create(dir.path(), "");
    db.create_table(notes_schema());
    Row row;
    row.values = {Value::integer(7), Value::text("visible-in-the-file-9182")};
    db.insert_row("notes", row);
    db.checkpoint();
  }
  CHECK(stored_somewhere(dir.path(), "visible-in-the-file-9182"));
}

IAQS_TEST(plain_store, refuses_a_password_it_does_not_have) {
  TestDir dir("no-password");
  {
    Database db = Database::create(dir.path(), "");
  }
  CHECK_THROW(Database::open(dir.path(), "something"), std::runtime_error);
}

IAQS_TEST(plain_store, password_operations_are_refused) {
  TestDir dir("no-passwd-ops");
  Database db = Database::create(dir.path(), "");
  CHECK_THROW(db.change_password("new-password-1"), std::runtime_error);
  CHECK_THROW(db.rekey_data(), std::runtime_error);
}

IAQS_TEST(plain_store, encrypted_mode_still_works_beside_it) {
  TestDir dir("encrypted");
  {
    Database db = Database::create(dir.path(), "upstream-password-1");
    CHECK(db.encrypted() == true);
  }
  CHECK_THROW(Database::open(dir.path(), ""), std::runtime_error);
  CHECK_THROW(Database::open(dir.path(), "wrong-password"), std::runtime_error);
  Database db = Database::open(dir.path(), "upstream-password-1");
  CHECK(db.encrypted() == true);
}

IAQS_TEST(plain_store, a_repository_initialises_without_a_password) {
  TestDir dir("repo");
  {
    vcs::Repo repo = vcs::Repo::init(fs::path(dir.path()), "");
    CHECK(repo.database().encrypted() == false);
  }
  vcs::Repo reopened = vcs::Repo::open(fs::path(dir.path()), "");
  CHECK(reopened.database().encrypted() == false);
}
