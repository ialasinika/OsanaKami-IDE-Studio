#include <algorithm>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <stdexcept>
#include <string>

#include "../harness.h"
#include "db/database.h"
#include "db/row.h"

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
      : path_(fs::temp_directory_path() / ("iaqs-db-" + std::string(name) +
                                           "-" + unique_suffix())) {
    std::error_code ec;
    fs::remove_all(path_, ec);
  }
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

void copy_dir(const std::string& from, const std::string& to) {
  fs::copy(fs::path(from), fs::path(to),
           fs::copy_options::recursive | fs::copy_options::overwrite_existing);
  // The copy must not inherit the live single-writer lock.
  std::error_code ec;
  fs::remove(fs::path(to) / "locked", ec);
}

TableSchema people_schema() {
  TableSchema schema;
  schema.name = "people";
  schema.columns = {
      ColumnDef{"id", ValueType::Integer, true, true},
      ColumnDef{"name", ValueType::Text, false, true},
      ColumnDef{"score", ValueType::Real, false, false},
      ColumnDef{"avatar", ValueType::Blob, false, false},
      ColumnDef{"note", ValueType::Text, false, false},
  };
  return schema;
}

Row make_row(int64_t id, const std::string& name, double score,
             const std::string& avatar, bool with_note) {
  Row row;
  row.values = {Value::integer(id), Value::text(name), Value::real(score),
                Value::blob(avatar)};
  row.values.push_back(with_note ? Value::text("hello") : Value::null());
  return row;
}

}  // namespace

IAQS_TEST(database, create_open_roundtrip) {
  TestDir dir("create");
  {
    Database db = Database::create(dir.path());
    CHECK(!db.table_exists("people"));
    CHECK_EQ(db.wal_generation(), 1u);
    CHECK_EQ(db.manifest().page_size, 8192u);
  }
  Database db = Database::open(dir.path());
  CHECK_EQ(db.table_names().size(), 0u);
}

IAQS_TEST(database, missing_manifest_rejected) {
  TestDir dir("missing");
  CHECK_THROW(Database::open(dir.path()), std::runtime_error);
  std::error_code ec;
  fs::create_directories(fs::path(dir.path()), ec);
  CHECK_THROW(Database::open(dir.path()), std::runtime_error);
}

IAQS_TEST(database, create_table_rejects_bad_schema) {
  TestDir dir("schema");
  Database db = Database::create(dir.path());
  TableSchema empty;
  empty.name = "t";
  CHECK_THROW(db.create_table(empty), std::runtime_error);

  TableSchema dup;
  dup.name = "t";
  dup.columns = {ColumnDef{"a", ValueType::Integer, false, false},
                 ColumnDef{"a", ValueType::Text, false, false}};
  CHECK_THROW(db.create_table(dup), std::runtime_error);

  TableSchema unnamed;
  unnamed.columns = {ColumnDef{"a", ValueType::Integer, false, false}};
  CHECK_THROW(db.create_table(unnamed), std::runtime_error);
}

IAQS_TEST(database, insert_scan_persist) {
  TestDir dir("persist");
  {
    Database db = Database::create(dir.path());
    db.create_table(people_schema());
    CHECK(db.table_exists("people"));
    CHECK_THROW(db.create_table(people_schema()), std::runtime_error);

    db.insert_row("people", make_row(1, "alice", 1.5, "a", true));
    db.insert_row("people", make_row(2, "bob", 2.5, "bb", false));
    db.insert_row("people", make_row(3, "carol", 3.5, "", true));

    const auto rows = db.scan_rows("people");
    CHECK_EQ(rows.size(), 3u);
    CHECK_EQ(rows[0].second.values.size(), 5u);
    CHECK_EQ(rows[0].second.values[0].int_value, int64_t{1});
    CHECK_EQ(rows[0].second.values[1].bytes, std::string("alice"));
    CHECK(rows[0].second.values[2].real_value == 1.5);
    CHECK_EQ(rows[0].second.values[3].bytes, std::string("a"));
    CHECK_EQ(rows[0].second.values[4].bytes, std::string("hello"));
    CHECK(rows[1].second.values[4].type == ValueType::Null);
  }
  Database db = Database::open(dir.path());
  CHECK_EQ(db.table_names().size(), 1u);
  CHECK(db.table_exists("people"));
  CHECK_EQ(db.scan_rows("people").size(), 3u);
}

IAQS_TEST(database, update_and_delete) {
  TestDir dir("update");
  {
    Database db = Database::create(dir.path());
    db.create_table(people_schema());
    const Rid rid = db.insert_row("people", make_row(7, "old", 0.5, "x", true));
    const Row fetched = db.get_row("people", rid);
    CHECK_EQ(fetched.values[1].bytes, std::string("old"));

    const Rid moved =
        db.update_row("people", rid, make_row(7, "new", 9.5, "y", false));
    CHECK(moved.slot != rid.slot || moved.ref.seg != rid.ref.seg ||
          moved.ref.page != rid.ref.page || moved.ref.generation != rid.ref.generation);
    const auto rows = db.scan_rows("people");
    CHECK_EQ(rows.size(), 1u);
    CHECK_EQ(rows[0].second.values[1].bytes, std::string("new"));
    CHECK(rows[0].second.values[4].type == ValueType::Null);

    CHECK_THROW(db.get_row("people", rid), std::runtime_error);
    db.delete_row("people", moved);
    CHECK_EQ(db.scan_rows("people").size(), 0u);
    CHECK_THROW(db.delete_row("people", moved), std::runtime_error);
  }
  Database db = Database::open(dir.path());
  CHECK_EQ(db.scan_rows("people").size(), 0u);
}

IAQS_TEST(database, rollback_discards_rows_and_catalog) {
  TestDir dir("rollback");
  Database db = Database::create(dir.path());
  db.create_table(people_schema());

  db.begin();
  CHECK(db.in_transaction());
  db.insert_row("people", make_row(1, "ghost", 1.0, "g", false));
  db.rollback();
  CHECK(!db.in_transaction());
  CHECK_EQ(db.scan_rows("people").size(), 0u);

  db.begin();
  TableSchema extra;
  extra.name = "extra";
  extra.columns = {ColumnDef{"a", ValueType::Integer, false, false}};
  db.create_table(extra);
  CHECK(db.table_exists("extra"));
  db.rollback();
  CHECK(!db.table_exists("extra"));

  CHECK_THROW(db.commit(), std::runtime_error);
  // A checkpoint outside a transaction is legal.
  db.checkpoint();
}

IAQS_TEST(database, wal_recovery_from_copied_directory) {
  TestDir live("wal-live");
  TestDir recovered("wal-copy");
  {
    Database db = Database::create(live.path());
    db.create_table(people_schema());
    // These auto-commit into the WAL; pages themselves are not flushed yet.
    db.insert_row("people", make_row(1, "alice", 1.5, "a", true));
    db.insert_row("people", make_row(2, "bob", 2.5, "b", false));
    copy_dir(live.path(), recovered.path());
  }
  Database db = Database::open(recovered.path());
  CHECK(db.table_exists("people"));
  const auto rows = db.scan_rows("people");
  CHECK_EQ(rows.size(), 2u);
  CHECK_EQ(rows[0].second.values[1].bytes, std::string("alice"));
  CHECK_EQ(rows[1].second.values[1].bytes, std::string("bob"));
}

IAQS_TEST(database, rolled_back_transaction_is_not_recovered) {
  TestDir live("wal-rollback-live");
  TestDir recovered("wal-rollback-copy");
  {
    Database db = Database::create(live.path());
    db.create_table(people_schema());
    db.begin();
    db.insert_row("people", make_row(1, "ghost", 0.0, "", false));
    db.rollback();
    copy_dir(live.path(), recovered.path());
  }
  Database db = Database::open(recovered.path());
  CHECK_EQ(db.scan_rows("people").size(), 0u);
}

IAQS_TEST(database, checkpoint_rotates_wal_and_keeps_data) {
  TestDir dir("checkpoint");
  {
    Database db = Database::create(dir.path());
    db.create_table(people_schema());
    db.insert_row("people", make_row(1, "alice", 1.0, "", true));
    const uint32_t before = db.wal_generation();
    db.checkpoint();
    CHECK(db.wal_generation() > before);
    CHECK_EQ(db.scan_rows("people").size(), 1u);
    db.insert_row("people", make_row(2, "bob", 2.0, "", false));
    db.close();
  }
  Database db = Database::open(dir.path());
  CHECK_EQ(db.scan_rows("people").size(), 2u);
}

IAQS_TEST(database, drop_table) {
  TestDir dir("drop");
  Database db = Database::create(dir.path());
  db.create_table(people_schema());
  db.insert_row("people", make_row(1, "alice", 1.0, "", false));
  db.drop_table("people");
  CHECK(!db.table_exists("people"));
  CHECK_THROW(db.scan_rows("people"), std::runtime_error);
  CHECK_THROW(db.drop_table("people"), std::runtime_error);
  CHECK_EQ(db.table_names().size(), 0u);
  db.close();

  Database reopened = Database::open(dir.path());
  CHECK_EQ(reopened.table_names().size(), 0u);
}

IAQS_TEST(database, row_shape_errors) {
  TestDir dir("row-shape");
  Database db = Database::create(dir.path());
  db.create_table(people_schema());

  Row too_few;
  too_few.values = {Value::integer(1)};
  CHECK_THROW(db.insert_row("people", too_few), std::runtime_error);

  Row wrong_type;
  wrong_type.values = {Value::text("id"), Value::text("name"), Value::real(0.0),
                       Value::blob(""), Value::null()};
  CHECK_THROW(db.insert_row("people", wrong_type), std::runtime_error);

  CHECK_THROW(db.insert_row("nope", make_row(1, "x", 0.0, "", false)),
              std::runtime_error);
  CHECK_THROW(db.get_row("people", Rid{}), std::runtime_error);
}
