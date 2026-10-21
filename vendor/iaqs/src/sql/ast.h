// iaqs SQL front end: AST for the M1/M2 SQL subset.
//
// This header contains data only: parsing produces the tree, the execution
// layer consumes it. No storage, no execution, no third-party dependencies.
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include "core/util.h"

namespace iaqs::sql {

// ---------------------------------------------------------------- expressions
struct Expr;
using ExprPtr = std::unique_ptr<Expr>;

// A literal stores the token as written in the SQL source for numbers ("42",
// "3.14", "-7"); the execution layer parses that text into INTEGER/REAL. String
// literals are stored with the surrounding quotes removed and the SQL escape
// '' already decoded to a single quote ("it''s" -> "it's"). NULL sets is_null
// and leaves `text` empty.
struct Literal {
  iaqs::Bytes text;
  bool is_null = false;
};

struct ColumnRef {
  std::string name;
};

struct NotExpr {
  ExprPtr operand;
};

struct IsNullExpr {
  ExprPtr operand;
  bool negated = false;  // true for `IS NOT NULL`
};

struct BinaryExpr {
  ExprPtr left;
  std::string op;  // "=", "!=", "<>", "<", "<=", ">", ">=", "AND", "OR"
  ExprPtr right;
};

// std::variant cannot hold incomplete types directly, so the recursive union is
// wrapped in this struct: every alternative is a complete type holding its
// children through ExprPtr (unique_ptr<Expr>). Tests and the execution layer
// read `expr.node` together with std::get/std::holds_alternative.
struct Expr {
  std::variant<Literal, ColumnRef, NotExpr, IsNullExpr, BinaryExpr> node;
};

// ---------------------------------------------------------------- statements
struct ColumnSpec {
  std::string name;
  std::string type_name;  // canonical upper case: INTEGER, REAL, TEXT, BLOB
  bool primary_key = false;
  bool not_null = false;
};

struct CreateTableStmt {
  std::string table;
  std::vector<ColumnSpec> columns;
};

struct InsertStmt {
  std::string table;
  std::vector<std::string> columns;  // empty = all columns, in table order
  std::vector<std::vector<Literal>> rows;
};

struct SelectStmt {
  bool star = true;
  std::vector<std::string> columns;  // empty when star is true
  std::string table;
  ExprPtr where;  // null = no WHERE clause
};

struct DeleteStmt {
  std::string table;
  ExprPtr where;  // null = no WHERE clause
};

struct UpdateStmt {
  // M1 restricts SET values to literals: Assign::value is a Literal, not an
  // arbitrary expression (see docs/design/06-database.md §6 for the full SQL).
  struct Assign {
    std::string column;
    Literal value;
  };
  std::string table;
  std::vector<Assign> assignments;
  ExprPtr where;  // null = no WHERE clause
};

// CREATE INDEX <name> ON <table> (<column>): one single-column secondary index.
struct CreateIndexStmt {
  std::string name;
  std::string table;
  std::string column;
};

// DROP INDEX <name>.
struct DropIndexStmt {
  std::string name;
};

using Stmt = std::variant<CreateTableStmt, InsertStmt, SelectStmt, DeleteStmt,
                          UpdateStmt, CreateIndexStmt, DropIndexStmt>;

// Parses zero or more ';'-separated statements. Empty input, whitespace only or
// comments only return an empty vector (with one exception: parse errors always
// throw). Keywords are case-insensitive, identifiers keep their source spelling.
// On any lexical or syntax error throws std::runtime_error whose message starts
// with "line:column: expected ...".
std::vector<Stmt> parse_sql(std::string_view text);

}  // namespace iaqs::sql
