// SQL execution layer: AST in, Database operations out.
//
// M1 scope: CREATE TABLE, INSERT, SELECT (projection + WHERE), DELETE, UPDATE.
// M2 scope: CREATE INDEX / DROP INDEX and index-assisted WHERE lookups (see the
// query-plan notes in exec.cpp). No joins, aggregates or subqueries. Every call
// runs as one transaction unless the caller already opened one.
#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "core/util.h"
#include "db/database.h"
#include "db/row.h"

namespace iaqs::sql {

struct ExecResult {
  std::vector<std::string> columns;       // SELECT projection
  std::vector<std::vector<iaqs::db::Value>> rows;
  uint64_t affected_rows = 0;             // INSERT/UPDATE/DELETE

  // Query-plan observability: true when the statement ran a secondary-index
  // probe instead of a full table scan, and the name of the index it picked.
  // DDL and INSERT results leave these false/empty.
  bool used_index = false;
  std::string index_name;

  bool has_rows() const { return !columns.empty(); }
};

class SqlExecutor {
 public:
  explicit SqlExecutor(iaqs::db::Database& db) : db_(db) {}

  // Parses and runs every ';'-separated statement; returns the result of the
  // last statement. Throws std::runtime_error on parse, type or constraint
  // errors, rolling back the whole script.
  ExecResult execute(std::string_view sql);

 private:
  iaqs::db::Database& db_;
};

}  // namespace iaqs::sql
