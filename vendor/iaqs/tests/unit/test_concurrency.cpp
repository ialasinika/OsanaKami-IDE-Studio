#include "harness.h"

#include <cstdlib>
#include <filesystem>
#include <string>
#include <thread>

#include "db/database.h"
#include "db/row.h"

using namespace iaqs;
using iaqs::db::ColumnDef;
using iaqs::db::Database;
using iaqs::db::Row;
using iaqs::db::TableSchema;
using iaqs::db::Value;
using iaqs::db::ValueType;

namespace {

struct TestDir {
  std::filesystem::path path;

  TestDir() {
    path = std::filesystem::temp_directory_path() /
           ("iaqs_concurrency_" + std::to_string(::rand()) + "_" +
            std::to_string(reinterpret_cast<uintptr_t>(this)));
    std::filesystem::create_directories(path);
  }

  ~TestDir() {
    std::error_code ec;
    std::filesystem::remove_all(path, ec);
  }

  std::string str() const { return path.string(); }
};

TableSchema counters_schema() {
  TableSchema schema;
  schema.name = "counters";
  schema.columns.push_back(ColumnDef{"id", ValueType::Integer, true, false});
  schema.columns.push_back(ColumnDef{"label", ValueType::Text, false, false});
  return schema;
}

Row counter_row(int64_t id, std::string_view label) {
  Row row;
  row.values.push_back(Value::integer(id));
  row.values.push_back(Value::text(std::string(label)));
  return row;
}

std::size_t count_rows(Database& db, const std::string& table) {
  return db.scan_rows(table).size();
}

}  // namespace

// Two connections to one database: each write transaction must observe what
// the other connection committed.
IAQS_TEST(concurrency, two_connections_see_each_others_commits) {
  TestDir dir;
  Database first = Database::create(dir.str(), "concurrency-pw-1", 1024);
  first.begin();
  first.create_table(counters_schema());
  first.insert_row("counters", counter_row(1, "first"));
  first.commit();

  Database second = Database::open(dir.str(), "concurrency-pw-1");
  CHECK_EQ(count_rows(first, "counters"), size_t{1});
  CHECK_EQ(count_rows(second, "counters"), size_t{1});

  second.begin();
  second.insert_row("counters", counter_row(2, "second"));
  second.commit();

  // The first connection knows nothing yet until it starts a transaction.
  first.begin();
  CHECK_EQ(count_rows(first, "counters"), size_t{2});
  first.insert_row("counters", counter_row(3, "third"));
  first.commit();

  second.begin();
  CHECK_EQ(count_rows(second, "counters"), size_t{3});
  second.commit();
}

// A table created by one connection is visible to the next transaction of
// another connection (catalog refresh at begin, not only at open).
IAQS_TEST(concurrency, catalog_changes_are_visible_to_other_connections) {
  TestDir dir;
  Database first = Database::create(dir.str(), "concurrency-pw-2", 1024);
  first.begin();
  first.create_table(counters_schema());
  first.commit();

  Database second = Database::open(dir.str(), "concurrency-pw-2");

  first.begin();
  TableSchema extra;
  extra.name = "extra";
  extra.columns.push_back(ColumnDef{"id", ValueType::Integer, true, false});
  first.create_table(extra);
  first.commit();

  second.begin();
  CHECK(second.table_exists("extra"));
  second.commit();

  // And a rollback must also start from the refreshed view.
  Row only_id;
  only_id.values.push_back(Value::integer(7));
  first.begin();
  first.insert_row("extra", only_id);
  first.rollback();
  first.begin();
  CHECK_EQ(count_rows(first, "extra"), size_t{0});
  first.commit();
}

// The cross-process lock is held for the whole write transaction, so another
// connection cannot start writing in the middle; it can after the commit.
IAQS_TEST(concurrency, writer_lock_is_held_for_the_transaction) {
  TestDir dir;
  Database first = Database::create(dir.str(), "concurrency-pw-3", 1024);
  first.begin();
  first.create_table(counters_schema());
  first.commit();

  Database second = Database::open(dir.str(), "concurrency-pw-3");
  first.begin();
  first.insert_row("counters", counter_row(1, "held"));

  std::string failure;
  std::thread writer([&] {
    try {
      second.begin();
      second.rollback();
    } catch (const std::exception& e) {
      failure = e.what();
    }
  });
  writer.join();
  CHECK(!failure.empty());
  CHECK(failure.find("locked") != std::string::npos);

  first.commit();

  // After the commit the lock is available again.
  second.begin();
  CHECK_EQ(count_rows(second, "counters"), size_t{1});
  second.commit();
}

// Interleaved short transactions from two connections both survive a reopen.
IAQS_TEST(concurrency, interleaved_transactions_survive_reopen) {
  TestDir dir;
  Database first = Database::create(dir.str(), "concurrency-pw-4", 1024);
  first.begin();
  first.create_table(counters_schema());
  first.commit();
  Database second = Database::open(dir.str(), "concurrency-pw-4");

  for (int i = 0; i < 6; ++i) {
    Database& db = (i % 2 == 0) ? first : second;
    db.begin();
    db.insert_row("counters",
                  counter_row(i, (i % 2 == 0) ? "even" : "odd"));
    db.commit();
  }

  first.close();
  second.close();

  Database reopened = Database::open(dir.str(), "concurrency-pw-4");
  reopened.begin();
  CHECK_EQ(count_rows(reopened, "counters"), size_t{6});
  reopened.commit();
}
