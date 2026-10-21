#include <atomic>
#include <chrono>
#include <filesystem>
#include <string>

#include "../harness.h"
#include "db/database.h"
#include "sql/exec.h"

namespace {

namespace fs = std::filesystem;
using iaqs::db::Database;

std::string unique_suffix() {
  static std::atomic<uint64_t> counter{0};
  const auto now = std::chrono::steady_clock::now().time_since_epoch().count();
  return std::to_string(now) + "-" + std::to_string(counter++);
}

class TestDir {
 public:
  explicit TestDir(const char* name)
      : path_(fs::temp_directory_path() / ("iaqs-sql-" + std::string(name) +
                                           "-" + unique_suffix())) {
    std::error_code ec;
    fs::remove_all(path_, ec);
  }
  ~TestDir() {
    std::error_code ec;
    fs::remove_all(path_, ec);
  }
  std::string path() const { return path_.string(); }

 private:
  fs::path path_;
};

const char* kSchema =
    "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, "
    "score REAL, avatar BLOB, note TEXT);";

}  // namespace

IAQS_TEST(sql_exec, create_insert_select) {
  TestDir dir("basic");
  Database db = Database::create(dir.path(), "pw");
  iaqs::sql::SqlExecutor executor(db);

  executor.execute(kSchema);
  CHECK(db.table_exists("people"));

  const auto inserted = executor.execute(
      "INSERT INTO people (id, name, score) VALUES "
      "(1, 'alice', 1.5), (2, 'bob', 2.5), (3, 'carol', NULL);");
  CHECK_EQ(inserted.affected_rows, uint64_t{3});

  const auto all = executor.execute("SELECT * FROM people;");
  CHECK_EQ(all.columns.size(), 5u);
  CHECK_EQ(all.columns[0], std::string("id"));
  CHECK_EQ(all.columns[1], std::string("name"));
  CHECK_EQ(all.rows.size(), 3u);
  CHECK_EQ(all.rows[0][0].int_value, int64_t{1});
  CHECK_EQ(all.rows[0][1].bytes, std::string("alice"));
  CHECK(all.rows[0][2].real_value == 1.5);
  CHECK_EQ(all.rows[0][3].type, iaqs::db::ValueType::Null);
  CHECK_EQ(all.rows[2][2].type, iaqs::db::ValueType::Null);

  const auto projected = executor.execute("SELECT name, id FROM people;");
  CHECK_EQ(projected.columns.size(), 2u);
  CHECK_EQ(projected.columns[0], std::string("name"));
  CHECK_EQ(projected.rows.size(), 3u);
  CHECK_EQ(projected.rows[1][0].bytes, std::string("bob"));
  CHECK_EQ(projected.rows[1][1].int_value, int64_t{2});
}

IAQS_TEST(sql_exec, insert_with_column_list_and_omitted_columns) {
  TestDir dir("insert-cols");
  Database db = Database::create(dir.path(), "pw");
  iaqs::sql::SqlExecutor executor(db);
  executor.execute(kSchema);

  executor.execute("INSERT INTO people (name, id) VALUES ('x', 10);");
  const auto rows = executor.execute("SELECT * FROM people;");
  CHECK_EQ(rows.rows.size(), 1u);
  CHECK_EQ(rows.rows[0][0].int_value, int64_t{10});
  CHECK_EQ(rows.rows[0][1].bytes, std::string("x"));
  CHECK_EQ(rows.rows[0][2].type, iaqs::db::ValueType::Null);

  // Column list/value count mismatch.
  CHECK_THROW(executor.execute("INSERT INTO people (id, name) VALUES (11);"),
              std::runtime_error);
  // NOT NULL violation.
  CHECK_THROW(executor.execute("INSERT INTO people (id) VALUES (12);"),
              std::runtime_error);
  // Unknown column.
  CHECK_THROW(executor.execute("INSERT INTO people (nope) VALUES (1);"),
              std::runtime_error);
}

IAQS_TEST(sql_exec, select_where_expressions) {
  TestDir dir("where");
  Database db = Database::create(dir.path(), "pw");
  iaqs::sql::SqlExecutor executor(db);
  executor.execute(kSchema);
  executor.execute(
      "INSERT INTO people (id, name, score, note) VALUES "
      "(1, 'alice', 1.5, 'hello'), (2, 'bob', 2.5, NULL), "
      "(3, 'carol', 3.5, 'hi'), (4, 'dave', NULL, NULL);");

  auto run = [&](const char* sql) { return executor.execute(sql); };

  CHECK_EQ(run("SELECT * FROM people WHERE id = 3;").rows.size(), 1u);
  CHECK_EQ(run("SELECT * FROM people WHERE id <> 3;").rows.size(), 3u);
  CHECK_EQ(run("SELECT * FROM people WHERE id >= 2 AND id <= 3;").rows.size(),
           2u);
  CHECK_EQ(run("SELECT * FROM people WHERE id = 1 OR name = 'dave';").rows.size(),
           2u);
  CHECK_EQ(run("SELECT * FROM people WHERE NOT (id = 1);").rows.size(), 3u);
  CHECK_EQ(run("SELECT * FROM people WHERE score > 2.0;").rows.size(), 2u);
  CHECK_EQ(run("SELECT * FROM people WHERE name = 'carol';").rows.size(), 1u);
  CHECK_EQ(run("SELECT * FROM people WHERE note IS NULL;").rows.size(), 2u);
  CHECK_EQ(run("SELECT * FROM people WHERE note IS NOT NULL;").rows.size(), 2u);
  CHECK_EQ(run("SELECT * FROM people WHERE id = 99;").rows.size(), 0u);

  // Case-insensitive keywords and columns.
  CHECK_EQ(run("select NAME from PEOPLE where ID = 2;").rows.size(), 1u);
}

IAQS_TEST(sql_exec, update_and_delete) {
  TestDir dir("update-delete");
  Database db = Database::create(dir.path(), "pw");
  iaqs::sql::SqlExecutor executor(db);
  executor.execute(kSchema);
  executor.execute(
      "INSERT INTO people (id, name, score) VALUES "
      "(1, 'alice', 1.0), (2, 'bob', 2.0), (3, 'carol', 3.0);");

  const auto updated = executor.execute(
      "UPDATE people SET score = 9.5, name = 'ALICE' WHERE id = 1;");
  CHECK_EQ(updated.affected_rows, uint64_t{1});
  const auto updated_rows =
      executor.execute("SELECT name, score FROM people WHERE id = 1;");
  CHECK_EQ(updated_rows.rows[0][0].bytes, std::string("ALICE"));
  CHECK(updated_rows.rows[0][1].real_value == 9.5);

  // alice was updated to 9.5 above, so this matches alice and carol.
  const auto deleted =
      executor.execute("DELETE FROM people WHERE score >= 3.0;");
  CHECK_EQ(deleted.affected_rows, uint64_t{2});
  CHECK_EQ(executor.execute("SELECT * FROM people;").rows.size(), 1u);

  // Deleting everything.
  const auto all = executor.execute("DELETE FROM people;");
  CHECK_EQ(all.affected_rows, uint64_t{1});
  CHECK_EQ(executor.execute("SELECT * FROM people;").rows.size(), 0u);

  // NULL violates NOT NULL on update.
  executor.execute("INSERT INTO people (id, name) VALUES (7, 'seven');");
  CHECK_THROW(
      executor.execute("UPDATE people SET name = NULL WHERE id = 7;"),
      std::runtime_error);
}

IAQS_TEST(sql_exec, multi_statement_script_is_atomic) {
  TestDir dir("script");
  Database db = Database::create(dir.path(), "pw");
  iaqs::sql::SqlExecutor executor(db);

  const auto last = executor.execute(
      "CREATE TABLE t (id INTEGER, v TEXT);"
      "INSERT INTO t VALUES (1, 'one');"
      "INSERT INTO t VALUES (2, 'two');"
      "SELECT * FROM t WHERE id = 2;");
  CHECK_EQ(last.columns.size(), 2u);
  CHECK_EQ(last.rows.size(), 1u);
  CHECK_EQ(last.rows[0][1].bytes, std::string("two"));

  // A failing later statement rolls the whole script back.
  CHECK_THROW(executor.execute(
                  "INSERT INTO t VALUES (3, 'three');"
                  "INSERT INTO nope VALUES (4, 'four');"),
              std::runtime_error);
  const auto rows = executor.execute("SELECT * FROM t;");
  CHECK_EQ(rows.rows.size(), 2u);

  // Parse errors roll back as well.
  CHECK_THROW(executor.execute("INSERT INTO t VALUES (5, 'five'); junk junk"),
              std::runtime_error);
  CHECK_EQ(executor.execute("SELECT * FROM t;").rows.size(), 2u);
}

IAQS_TEST(sql_exec, type_and_name_errors) {
  TestDir dir("errors");
  Database db = Database::create(dir.path(), "pw");
  iaqs::sql::SqlExecutor executor(db);

  CHECK_THROW(executor.execute("CREATE TABLE bad (c WHATEVER);"),
              std::runtime_error);
  executor.execute(kSchema);
  CHECK_THROW(executor.execute("SELECT * FROM missing;"), std::runtime_error);
  CHECK_THROW(executor.execute("SELECT nope FROM people;"), std::runtime_error);

  // Text into INTEGER is a type error; INTEGER into TEXT keeps the digits.
  CHECK_THROW(executor.execute("INSERT INTO people (id, name) VALUES ('abc', 'x');"),
              std::runtime_error);
  executor.execute("INSERT INTO people (id, name) VALUES (5, 'digits');");
  const auto rows = executor.execute("SELECT id FROM people;");
  CHECK_EQ(rows.rows.size(), 1u);

  // NULL in a not-null column.
  CHECK_THROW(executor.execute("INSERT INTO people (id, name) VALUES (6, NULL);"),
              std::runtime_error);
}

IAQS_TEST(sql_exec, empty_and_comment_only_scripts) {
  TestDir dir("empty");
  Database db = Database::create(dir.path(), "pw");
  iaqs::sql::SqlExecutor executor(db);
  const auto empty = executor.execute("");
  CHECK(empty.columns.empty());
  CHECK(empty.rows.empty());
  const auto comments = executor.execute("-- nothing here\n -- still nothing");
  CHECK(comments.columns.empty());
  CHECK(comments.rows.empty());
  CHECK(!db.in_transaction());
}
