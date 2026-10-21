// M2 secondary indexes: key encoding, SQL surface (CREATE/DROP INDEX), catalog
// persistence, INSERT/UPDATE/DELETE maintenance and the index-assisted plan for
// SELECT/UPDATE/DELETE ... WHERE.
#include <atomic>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <limits>
#include <string>
#include <vector>

#include "../harness.h"
#include "db/database.h"
#include "db/index.h"
#include "sql/ast.h"
#include "sql/exec.h"

namespace {

namespace fs = std::filesystem;
using iaqs::db::Database;
using iaqs::db::IndexKey;
using iaqs::db::Rid;
using iaqs::db::Row;
using iaqs::db::TableSchema;
using iaqs::db::Value;
using iaqs::db::ValueType;
using iaqs::sql::SqlExecutor;

std::string unique_suffix() {
  static std::atomic<uint64_t> counter{0};
  const auto now = std::chrono::steady_clock::now().time_since_epoch().count();
  return std::to_string(now) + "-" + std::to_string(counter++);
}

class TestDir {
 public:
  explicit TestDir(const char* name)
      : path_(fs::temp_directory_path() / ("iaqs-index-" + std::string(name) +
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
    "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, score REAL, "
    "note TEXT);";

// Five rows over which the equality/range cases are defined:
//   id=1 alpha 1.0 'one'   id=2 beta 2.0 'two'   id=3 gamma 3.0 NULL
//   id=4 alpha 4.0 'four'  id=5 delta 5.0 'five'
void insert_basic(SqlExecutor& executor) {
  executor.execute(
      "INSERT INTO items (id, name, score, note) VALUES "
      "(1, 'alpha', 1.0, 'one'), (2, 'beta', 2.0, 'two'), "
      "(3, 'gamma', 3.0, NULL), (4, 'alpha', 4.0, 'four'), "
      "(5, 'delta', 5.0, 'five');");
}

size_t row_count(SqlExecutor& executor, const char* sql) {
  return executor.execute(sql).rows.size();
}

int64_t only_integer(SqlExecutor& executor, const char* sql) {
  const auto result = executor.execute(sql);
  if (result.rows.size() != 1 || result.rows[0].empty()) {
    iaqs::test::fail_now(__FILE__, __LINE__,
                         std::string("expected exactly one row from: ") + sql);
  }
  return result.rows[0][0].int_value;
}

}  // namespace

// The 32-byte key must order like its value prefix so FixedBTree's memcmp()
// order matches SQL order, and the rid suffix must round-trip exactly.
IAQS_TEST(sql_index, key_encoding_is_order_preserving) {
  const std::vector<int64_t> integers = {
      std::numeric_limits<int64_t>::min(), -1000, -1, 0, 1, 1000,
      std::numeric_limits<int64_t>::max()};
  std::vector<IndexKey> integer_keys;
  for (const int64_t value : integers) {
    integer_keys.push_back(iaqs::db::encode_index_key(Value::integer(value), Rid{}));
  }
  for (size_t i = 0; i + 1 < integer_keys.size(); ++i) {
    CHECK(std::memcmp(integer_keys[i].data(), integer_keys[i + 1].data(),
                      iaqs::db::FixedBTree::kKeySize) < 0);
  }

  const std::vector<std::string> texts = {"", "app", "apple", "banana", "z"};
  std::vector<IndexKey> text_keys;
  for (const std::string& text : texts) {
    text_keys.push_back(iaqs::db::encode_index_key(Value::text(text), Rid{}));
  }
  for (size_t i = 0; i + 1 < text_keys.size(); ++i) {
    CHECK(std::memcmp(text_keys[i].data(), text_keys[i + 1].data(),
                      iaqs::db::FixedBTree::kKeySize) < 0);
  }

  Rid rid;
  rid.ref = iaqs::db::PageRef{7, 42, 99};
  rid.slot = 5;
  const IndexKey key = iaqs::db::encode_index_key(Value::text("x"), rid);
  const Rid back = iaqs::db::index_key_rid(key.data());
  CHECK_EQ(back.ref.seg, uint32_t{7});
  CHECK_EQ(back.ref.page, uint32_t{42});
  CHECK_EQ(back.slot, uint16_t{5});
  CHECK_EQ(back.ref.generation, uint32_t{0});

  CHECK_THROW(iaqs::db::encode_index_key(Value::null(), Rid{}),
              std::runtime_error);

  // REAL: -0.0 and +0.0 share one key; zero sorts between negative and
  // positive values.
  const IndexKey positive_zero =
      iaqs::db::encode_index_key(Value::real(0.0), Rid{});
  const IndexKey negative_zero =
      iaqs::db::encode_index_key(Value::real(-0.0), Rid{});
  CHECK(std::memcmp(positive_zero.data(), negative_zero.data(),
                    iaqs::db::FixedBTree::kKeySize) == 0);
  const IndexKey minus_one = iaqs::db::encode_index_key(Value::real(-1.0), Rid{});
  const IndexKey plus_one = iaqs::db::encode_index_key(Value::real(1.0), Rid{});
  CHECK(std::memcmp(minus_one.data(), negative_zero.data(),
                    iaqs::db::kIndexValuePrefixSize) < 0);
  CHECK(std::memcmp(negative_zero.data(), plus_one.data(),
                    iaqs::db::kIndexValuePrefixSize) < 0);
}

IAQS_TEST(sql_index, equality_lookup_uses_index_over_existing_rows) {
  TestDir dir("equality");
  Database db = Database::create(dir.path());
  SqlExecutor executor(db);
  executor.execute(kSchema);
  insert_basic(executor);

  // No index: full scan, results correct but used_index is false.
  const auto before = executor.execute("SELECT name FROM items WHERE id = 3;");
  CHECK(!before.used_index);
  CHECK(before.index_name.empty());

  executor.execute("CREATE INDEX idx_items_id ON items (id);");
  CHECK(db.index_exists("idx_items_id"));
  CHECK(db.index_exists("IDX_ITEMS_ID"));  // names are case-insensitive
  const iaqs::db::IndexInfo* info = db.find_index("items", "id");
  CHECK(info != nullptr);
  CHECK_EQ(info->column, std::string("id"));
  CHECK_EQ(info->type, ValueType::Integer);
  CHECK_EQ(db.find_index("items", "name"), nullptr);

  // The index was built from the rows inserted before CREATE INDEX.
  const auto by_id = executor.execute("SELECT name FROM items WHERE id = 3;");
  CHECK(by_id.used_index);
  CHECK_EQ(by_id.index_name, std::string("idx_items_id"));
  CHECK_EQ(by_id.rows.size(), 1u);
  CHECK_EQ(by_id.rows[0][0].bytes, std::string("gamma"));

  // SQL identifiers are case-insensitive end to end.
  const auto upper = executor.execute("SELECT ID FROM ITEMS WHERE ID = 2;");
  CHECK(upper.used_index);
  CHECK_EQ(upper.rows.size(), 1u);

  // An unindexed column still scans.
  const auto by_name = executor.execute("SELECT id FROM items WHERE name = 'alpha';");
  CHECK(!by_name.used_index);
  CHECK_EQ(by_name.rows.size(), 2u);
}

IAQS_TEST(sql_index, insert_update_delete_maintain_index) {
  TestDir dir("maintain");
  Database db = Database::create(dir.path());
  SqlExecutor executor(db);
  executor.execute(kSchema);
  executor.execute("CREATE INDEX idx_items_name ON items (name);");
  executor.execute("CREATE INDEX idx_items_id ON items (id);");

  // INSERT.
  executor.execute("INSERT INTO items (id, name) VALUES (1, 'alpha');");
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE name = 'alpha';"), 1u);

  // UPDATE of the indexed column: the old key disappears, the new one appears.
  executor.execute("UPDATE items SET name = 'beta' WHERE id = 1;");
  const auto old_key = executor.execute("SELECT id FROM items WHERE name = 'alpha';");
  CHECK(old_key.used_index);
  CHECK_EQ(old_key.rows.size(), 0u);
  const auto new_key = executor.execute("SELECT id FROM items WHERE name = 'beta';");
  CHECK(new_key.used_index);
  CHECK_EQ(new_key.rows.size(), 1u);
  CHECK_EQ(new_key.rows[0][0].int_value, int64_t{1});

  // UPDATE of a non-indexed column moves the row to a new rid; the index entry
  // must follow it.
  executor.execute("UPDATE items SET score = 7.5 WHERE id = 1;");
  const auto moved = executor.execute("SELECT score FROM items WHERE name = 'beta';");
  CHECK(moved.used_index);
  CHECK_EQ(moved.rows.size(), 1u);
  CHECK(moved.rows[0][0].real_value == 7.5);

  // DELETE removes the index entry.
  const auto deleted = executor.execute("DELETE FROM items WHERE name = 'beta';");
  CHECK(deleted.used_index);
  CHECK_EQ(deleted.affected_rows, uint64_t{1});
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE name = 'beta';"), 0u);
  CHECK_EQ(row_count(executor, "SELECT * FROM items;"), 0u);
}

IAQS_TEST(sql_index, integer_equality_and_range_scan) {
  TestDir dir("integer-range");
  Database db = Database::create(dir.path());
  SqlExecutor executor(db);
  executor.execute(kSchema);
  std::string sql = "INSERT INTO items (id, name) VALUES ";
  for (int i = 0; i < 10; ++i) {
    if (i != 0) sql += ", ";
    sql += "(" + std::to_string(i) + ", 'n" + std::to_string(i) + "')";
  }
  executor.execute(sql + ";");
  executor.execute("CREATE INDEX idx_items_id ON items (id);");

  const auto eq = executor.execute("SELECT name FROM items WHERE id = 4;");
  CHECK(eq.used_index);
  CHECK_EQ(eq.rows.size(), 1u);
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE id < 4;"), 4u);
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE id <= 4;"), 5u);
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE id > 4;"), 5u);
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE id >= 4;"), 6u);
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE id < 0;"), 0u);
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE id > 9;"), 0u);
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE id >= 0;"), 10u);
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE id = 11;"), 0u);

  CHECK(executor.execute("SELECT id FROM items WHERE id >= 4;").used_index);
  CHECK_EQ(executor.execute("SELECT id FROM items WHERE id >= 4;").index_name,
           std::string("idx_items_id"));

  // Two range terms on the indexed column: the plan uses the first one and the
  // re-check enforces the second.
  const auto between =
      executor.execute("SELECT id FROM items WHERE id >= 3 AND id <= 6;");
  CHECK(between.used_index);
  CHECK_EQ(between.rows.size(), 4u);

  // Indexed equality AND an unindexed predicate.
  const auto mixed = executor.execute(
      "SELECT id FROM items WHERE id = 2 AND name = 'n2';");
  CHECK(mixed.used_index);
  CHECK_EQ(mixed.rows.size(), 1u);

  // OR and != are not planned; results are still correct via the scan.
  const auto or_query =
      executor.execute("SELECT id FROM items WHERE id = 1 OR id = 2;");
  CHECK(!or_query.used_index);
  CHECK_EQ(or_query.rows.size(), 2u);
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE id <> 5;"), 9u);
}

IAQS_TEST(sql_index, text_equality_range_duplicates_and_long_values) {
  TestDir dir("text");
  Database db = Database::create(dir.path());
  SqlExecutor executor(db);
  executor.execute(kSchema);
  // Two values longer than the 22-byte key prefix share one prefix; both must
  // still be found/handled exactly.
  executor.execute(
      "INSERT INTO items (id, name) VALUES "
      "(1, 'apple'), (2, 'banana'), (3, 'cherry'), (4, 'apple'), "
      "(5, 'date'), (6, 'abcdefghijklmnopqrstuvwxyz-1'), "
      "(7, 'abcdefghijklmnopqrstuvwxyz-2'), (8, NULL);");
  executor.execute("CREATE INDEX idx_items_name ON items (name);");

  const auto dup = executor.execute("SELECT id FROM items WHERE name = 'apple';");
  CHECK(dup.used_index);
  CHECK_EQ(dup.rows.size(), 2u);

  const auto long_value = executor.execute(
      "SELECT id FROM items WHERE name = 'abcdefghijklmnopqrstuvwxyz-2';");
  CHECK(long_value.used_index);
  CHECK_EQ(long_value.rows.size(), 1u);
  CHECK_EQ(long_value.rows[0][0].int_value, int64_t{7});

  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE name < 'cherry';"), 5u);
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE name >= 'cherry';"), 2u);
  CHECK_EQ(row_count(executor,
                     "SELECT id FROM items WHERE name > 'banana' AND name < 'date';"),
           1u);
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE name = 'zebra';"), 0u);
  CHECK(executor.execute("SELECT id FROM items WHERE name = 'zebra';").used_index);
}

IAQS_TEST(sql_index, real_equality_and_range) {
  TestDir dir("real");
  Database db = Database::create(dir.path());
  SqlExecutor executor(db);
  executor.execute(kSchema);
  executor.execute(
      "INSERT INTO items (id, score) VALUES "
      "(1, 1.5), (2, 2.5), (3, 2.5), (4, 3.5), (5, NULL);");
  executor.execute("CREATE INDEX idx_items_score ON items (score);");

  const auto eq = executor.execute("SELECT id FROM items WHERE score = 2.5;");
  CHECK(eq.used_index);
  CHECK_EQ(eq.rows.size(), 2u);
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE score > 2.0;"), 3u);
  CHECK_EQ(row_count(executor,
                     "SELECT id FROM items WHERE score >= 2.5 AND score < 3.5;"),
           2u);
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE score = 1.5;"), 1u);
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE score < 2.0;"), 1u);
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE score = 9.0;"), 0u);

  // -0.0 and +0.0 compare equal in SQL, so both must be found by the same
  // probe (the encoder normalizes both zeros onto one key).
  executor.execute("INSERT INTO items (id, score) VALUES (6, -0.0);");
  const auto zero = executor.execute("SELECT id FROM items WHERE score = 0.0;");
  CHECK(zero.used_index);
  CHECK_EQ(zero.rows.size(), 1u);
  CHECK_EQ(zero.rows[0][0].int_value, int64_t{6});
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE score >= 0.0;"), 5u);
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE score < 0.0;"), 0u);
}

IAQS_TEST(sql_index, null_values_are_not_indexed) {
  TestDir dir("null");
  Database db = Database::create(dir.path());
  SqlExecutor executor(db);
  executor.execute(kSchema);
  executor.execute("INSERT INTO items (id, name) VALUES (1, 'a'), (2, NULL), (3, 'b');");
  executor.execute("CREATE INDEX idx_items_name ON items (name);");

  const auto eq = executor.execute("SELECT id FROM items WHERE name = 'a';");
  CHECK(eq.used_index);
  CHECK_EQ(eq.rows.size(), 1u);

  // IS NULL is not an indexable comparison: the planner falls back to a scan.
  const auto is_null = executor.execute("SELECT id FROM items WHERE name IS NULL;");
  CHECK(!is_null.used_index);
  CHECK_EQ(is_null.rows.size(), 1u);
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE name IS NOT NULL;"), 2u);

  // NULL removes the entry; a later value re-adds one.
  executor.execute("UPDATE items SET name = NULL WHERE id = 1;");
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE name = 'a';"), 0u);
  executor.execute("UPDATE items SET name = 'a' WHERE id = 1;");
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE name = 'a';"), 1u);
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE name IS NULL;"), 1u);
}

IAQS_TEST(sql_index, error_paths) {
  TestDir dir("errors");
  Database db = Database::create(dir.path());
  SqlExecutor executor(db);
  executor.execute(kSchema);

  CHECK_THROW(executor.execute("CREATE INDEX idx ON missing (id);"),
              std::runtime_error);
  CHECK_THROW(executor.execute("CREATE INDEX idx ON items (nope);"),
              std::runtime_error);
  CHECK_THROW(executor.execute("CREATE INDEX ON items (id);"),
              std::runtime_error);
  CHECK_THROW(executor.execute("CREATE INDEX idx items (id);"),
              std::runtime_error);
  CHECK_THROW(executor.execute("CREATE INDEX idx ON items id;"),
              std::runtime_error);
  CHECK_THROW(executor.execute("CREATE INDEX idx ON items (id, name);"),
              std::runtime_error);
  // A failed script rolls back the index it created earlier.
  CHECK_THROW(executor.execute("CREATE INDEX idx ON items (id); DROP INDEX nope;"),
              std::runtime_error);
  CHECK(!db.index_exists("idx"));

  executor.execute("CREATE INDEX idx ON items (id);");
  CHECK(db.index_exists("IDX"));
  CHECK_THROW(executor.execute("CREATE INDEX idx ON items (name);"),
              std::runtime_error);  // duplicate name, case-insensitive
  CHECK_THROW(executor.execute("CREATE INDEX IDX ON items (name);"),
              std::runtime_error);
  CHECK_THROW(executor.execute("DROP INDEX missing;"), std::runtime_error);
  CHECK_THROW(executor.execute("DROP TABLE items;"), std::runtime_error);

  executor.execute("DROP INDEX IDX;");
  CHECK(!db.index_exists("idx"));
  CHECK_EQ(db.index_names().size(), 0u);
  CHECK_THROW(executor.execute("DROP INDEX idx;"), std::runtime_error);
}

IAQS_TEST(sql_index, index_survives_reopen) {
  TestDir dir("persist");
  {
    Database db = Database::create(dir.path());
    SqlExecutor executor(db);
    executor.execute(kSchema);
    insert_basic(executor);
    executor.execute("CREATE INDEX idx_items_name ON items (name);");
    db.close();
  }

  Database db = Database::open(dir.path());
  CHECK(db.index_exists("idx_items_name"));
  const iaqs::db::IndexInfo* info = db.find_index("items", "NAME");
  CHECK(info != nullptr);
  CHECK_EQ(info->name, std::string("idx_items_name"));
  CHECK_EQ(info->table, std::string("items"));
  CHECK_EQ(info->column, std::string("name"));
  CHECK_EQ(info->type, ValueType::Text);

  SqlExecutor executor(db);
  const auto existing = executor.execute("SELECT id FROM items WHERE name = 'alpha';");
  CHECK(existing.used_index);
  CHECK_EQ(existing.rows.size(), 2u);

  // Writes after reopen keep maintaining the persisted index.
  executor.execute("INSERT INTO items (id, name) VALUES (6, 'alpha');");
  const auto after = executor.execute("SELECT id FROM items WHERE name = 'alpha';");
  CHECK(after.used_index);
  CHECK_EQ(after.rows.size(), 3u);
  db.close();
}

IAQS_TEST(sql_index, query_plan_selection_and_fallback) {
  TestDir dir("plan");
  Database db = Database::create(dir.path());
  SqlExecutor executor(db);
  executor.execute(kSchema);
  executor.execute(
      "INSERT INTO items (id, name, score) VALUES "
      "(1, 'alpha', 10.0), (2, 'beta', 20.0), (3, 'alpha', 30.0), "
      "(4, 'gamma', 40.0);");
  executor.execute("CREATE INDEX idx_items_name ON items (name);");

  const auto eq = executor.execute("SELECT id FROM items WHERE name = 'alpha';");
  CHECK(eq.used_index);
  CHECK_EQ(eq.index_name, std::string("idx_items_name"));
  CHECK_EQ(eq.rows.size(), 2u);

  // AND with an unindexed predicate: the index narrows, the re-check filters.
  const auto mixed = executor.execute(
      "SELECT id FROM items WHERE name = 'alpha' AND score > 20.0;");
  CHECK(mixed.used_index);
  CHECK_EQ(mixed.rows.size(), 1u);
  CHECK_EQ(mixed.rows[0][0].int_value, int64_t{3});

  // A literal on the left is flipped into a column-on-left probe.
  const auto flipped = executor.execute("SELECT id FROM items WHERE 'alpha' = name;");
  CHECK(flipped.used_index);
  CHECK_EQ(flipped.rows.size(), 2u);

  // Range on the indexed column.
  const auto range = executor.execute("SELECT id FROM items WHERE name < 'beta';");
  CHECK(range.used_index);
  CHECK_EQ(range.rows.size(), 2u);

  // Unindexed column, OR and NOT all fall back to a scan.
  const auto unindexed = executor.execute("SELECT id FROM items WHERE score > 20.0;");
  CHECK(!unindexed.used_index);
  CHECK_EQ(unindexed.rows.size(), 2u);
  const auto or_query =
      executor.execute("SELECT id FROM items WHERE name = 'alpha' OR name = 'beta';");
  CHECK(!or_query.used_index);
  CHECK_EQ(or_query.rows.size(), 3u);
  const auto not_query = executor.execute("SELECT id FROM items WHERE NOT name = 'alpha';");
  CHECK(!not_query.used_index);
  CHECK_EQ(not_query.rows.size(), 2u);
  const auto all = executor.execute("SELECT id FROM items;");
  CHECK(!all.used_index);
  CHECK_EQ(all.rows.size(), 4u);

  // Unknown columns still fail, whether or not an index exists elsewhere.
  CHECK_THROW(executor.execute("SELECT id FROM items WHERE bogus = 1;"),
              std::runtime_error);
}

IAQS_TEST(sql_index, update_delete_where_use_index) {
  TestDir dir("dml");
  Database db = Database::create(dir.path());
  SqlExecutor executor(db);
  executor.execute(kSchema);
  executor.execute(
      "INSERT INTO items (id, name, score) VALUES "
      "(1, 'alpha', 1.0), (2, 'beta', 2.0), (3, 'alpha', 3.0), "
      "(4, 'gamma', 4.0);");
  executor.execute("CREATE INDEX idx_items_name ON items (name);");

  const auto deleted = executor.execute("DELETE FROM items WHERE name = 'alpha';");
  CHECK(deleted.used_index);
  CHECK_EQ(deleted.affected_rows, uint64_t{2});

  const auto updated =
      executor.execute("UPDATE items SET score = 99.0 WHERE name = 'beta';");
  CHECK(updated.used_index);
  CHECK_EQ(updated.affected_rows, uint64_t{1});
  CHECK_EQ(only_integer(executor, "SELECT id FROM items WHERE score = 99.0;"),
           int64_t{2});

  // Renaming an indexed column through an indexed WHERE: old key removed, new
  // key inserted.
  const auto renamed =
      executor.execute("UPDATE items SET name = 'delta' WHERE name = 'beta';");
  CHECK(renamed.used_index);
  CHECK_EQ(renamed.affected_rows, uint64_t{1});
  CHECK_EQ(row_count(executor, "SELECT id FROM items WHERE name = 'beta';"), 0u);
  const auto delta = executor.execute("SELECT id FROM items WHERE name = 'delta';");
  CHECK(delta.used_index);
  CHECK_EQ(delta.rows.size(), 1u);
  CHECK_EQ(row_count(executor, "SELECT * FROM items;"), 2u);
}

IAQS_TEST(sql_index, direct_database_api_and_drop_table) {
  TestDir dir("direct");
  Database db = Database::create(dir.path());

  TableSchema schema;
  schema.name = "people";
  iaqs::db::ColumnDef id;
  id.name = "id";
  id.type = ValueType::Integer;
  id.primary_key = true;
  id.not_null = true;
  iaqs::db::ColumnDef name;
  name.name = "name";
  name.type = ValueType::Text;
  schema.columns = {id, name};
  db.create_table(schema);

  Row first;
  first.values = {Value::integer(1), Value::text("ada")};
  db.insert_row("people", first);
  db.create_index("idx_people_name", "people", "name");
  CHECK(db.index_exists("idx_people_name"));
  CHECK_EQ(db.index_names().size(), 1u);
  CHECK_EQ(db.index_names()[0], std::string("idx_people_name"));
  CHECK(db.find_index("people", "NAME") != nullptr);
  CHECK(db.find_index("people", "id") == nullptr);

  // The direct-API insert after CREATE INDEX lands in the index too.
  Row second;
  second.values = {Value::integer(2), Value::text("bob")};
  db.insert_row("people", second);
  SqlExecutor executor(db);
  const auto by_name = executor.execute("SELECT id FROM people WHERE name = 'bob';");
  CHECK(by_name.used_index);
  CHECK_EQ(by_name.rows.size(), 1u);
  CHECK_EQ(by_name.rows[0][0].int_value, int64_t{2});

  // Dropping the table drops its indexes.
  db.drop_table("people");
  CHECK_EQ(db.index_names().size(), 0u);
  CHECK(!db.index_exists("idx_people_name"));
  CHECK(db.find_index("people", "name") == nullptr);
}

IAQS_TEST(sql_index, parser_accepts_index_statements) {
  const std::vector<iaqs::sql::Stmt> statements = iaqs::sql::parse_sql(
      "CREATE INDEX idx ON people (name); DROP INDEX idx;");
  CHECK_EQ(statements.size(), 2u);

  const auto* create = std::get_if<iaqs::sql::CreateIndexStmt>(&statements[0]);
  CHECK(create != nullptr);
  CHECK_EQ(create->name, std::string("idx"));
  CHECK_EQ(create->table, std::string("people"));
  CHECK_EQ(create->column, std::string("name"));

  const auto* drop = std::get_if<iaqs::sql::DropIndexStmt>(&statements[1]);
  CHECK(drop != nullptr);
  CHECK_EQ(drop->name, std::string("idx"));

  CHECK_THROW(iaqs::sql::parse_sql("CREATE INDEX idx ON people (name, extra);"),
              std::runtime_error);
  CHECK_THROW(iaqs::sql::parse_sql("CREATE UNIQUE INDEX idx ON people (name);"),
              std::runtime_error);
  CHECK_THROW(iaqs::sql::parse_sql("DROP INDEX;"), std::runtime_error);
}
