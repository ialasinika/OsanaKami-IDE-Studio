#include "sql/exec.h"

#include <charconv>
#include <cstdlib>
#include <optional>
#include <string>
#include <utility>

#include "db/btree.h"
#include "db/index.h"
#include "sql/ast.h"

namespace iaqs::sql {
namespace {

using db::ColumnDef;
using db::Database;
using db::Row;
using db::TableInfo;
using db::TableSchema;
using db::Value;
using db::ValueType;

template <class... Ts>
struct Overloaded : Ts... {
  using Ts::operator()...;
};
template <class... Ts>
Overloaded(Ts...) -> Overloaded<Ts...>;

ValueType type_from_name(std::string_view name) {
  const std::string lowered = to_lower_ascii(name);
  if (lowered == "integer" || lowered == "int") return ValueType::Integer;
  if (lowered == "real" || lowered == "double" || lowered == "float") {
    return ValueType::Real;
  }
  if (lowered == "text" || lowered == "string") return ValueType::Text;
  if (lowered == "blob") return ValueType::Blob;
  throw std::runtime_error("unknown column type: " + std::string(name));
}

bool parse_integer_text(std::string_view text, int64_t& out) {
  if (text.empty()) return false;
  const char* first = text.data();
  const char* last = text.data() + text.size();
  const auto result = std::from_chars(first, last, out);
  return result.ec == std::errc() && result.ptr == last;
}

bool parse_real_text(std::string_view text, double& out) {
  if (text.empty()) return false;
  const std::string buffer(text);
  char* end = nullptr;
  const double value = std::strtod(buffer.c_str(), &end);
  if (end != buffer.c_str() + buffer.size()) return false;
  out = value;
  return true;
}

int column_index(const TableSchema& schema, const std::string& name) {
  const std::string lowered = to_lower_ascii(name);
  for (size_t i = 0; i < schema.columns.size(); ++i) {
    if (to_lower_ascii(schema.columns[i].name) == lowered) {
      return static_cast<int>(i);
    }
  }
  return -1;
}

// SQL table names are case-insensitive: the catalog stores the normalized
// (lower-case) spelling and every statement refers to it the same way.
std::string table_key(std::string_view name) { return to_lower_ascii(name); }

Value literal_to_value(const Literal& literal, ValueType target,
                       const TableSchema& schema, const std::string& table) {
  (void)schema;
  (void)table;
  if (literal.is_null) return Value::null();
  switch (target) {
    case ValueType::Integer: {
      int64_t v = 0;
      if (!parse_integer_text(literal.text, v)) {
        throw std::runtime_error("invalid INTEGER literal: '" + literal.text + "'");
      }
      return Value::integer(v);
    }
    case ValueType::Real: {
      double v = 0.0;
      if (!parse_real_text(literal.text, v)) {
        throw std::runtime_error("invalid REAL literal: '" + literal.text + "'");
      }
      return Value::real(v);
    }
    case ValueType::Text:
      return Value::text(literal.text);
    case ValueType::Blob:
      return Value::blob(literal.text);
    case ValueType::Null:
      break;
  }
  throw std::runtime_error("column has no type");
}

Value eval_expr(const Expr& expr, const TableSchema& schema, const Row& row);

bool truthy(const Value& value) {
  switch (value.type) {
    case ValueType::Null:
      return false;
    case ValueType::Integer:
      return value.int_value != 0;
    case ValueType::Real:
      return value.real_value != 0.0;
    case ValueType::Text:
    case ValueType::Blob:
      return !value.bytes.empty();
  }
  return false;
}

int compare_values(const Value& left, const Value& right);

// Coerces a TEXT literal-like operand to a number for mixed comparisons.
int compare_mixed(const Value& numeric, const Value& other) {
  double parsed = 0.0;
  if (!parse_real_text(other.bytes, parsed)) {
    throw std::runtime_error("cannot compare numeric value with text '" +
                             other.bytes + "'");
  }
  const double lhs = numeric.type == ValueType::Integer
                         ? static_cast<double>(numeric.int_value)
                         : numeric.real_value;
  return lhs < parsed ? -1 : (lhs > parsed ? 1 : 0);
}

int compare_values(const Value& left, const Value& right) {
  const bool left_numeric =
      left.type == ValueType::Integer || left.type == ValueType::Real;
  const bool right_numeric =
      right.type == ValueType::Integer || right.type == ValueType::Real;
  if (left_numeric && right_numeric) {
    if (left.type == ValueType::Integer && right.type == ValueType::Integer) {
      return left.int_value < right.int_value ? -1
             : left.int_value > right.int_value ? 1
                                            : 0;
    }
    const double lhs =
        left.type == ValueType::Integer ? static_cast<double>(left.int_value)
                                        : left.real_value;
    const double rhs =
        right.type == ValueType::Integer ? static_cast<double>(right.int_value)
                                         : right.real_value;
    return lhs < rhs ? -1 : (lhs > rhs ? 1 : 0);
  }
  if (left_numeric) return compare_mixed(left, right);
  if (right_numeric) {
    const int result = compare_mixed(right, left);
    return -result;
  }
  return left.bytes < right.bytes ? -1 : (left.bytes > right.bytes ? 1 : 0);
}

Value eval_binary(const BinaryExpr& binary, const TableSchema& schema,
                  const Row& row) {
  if (binary.op == "AND" || binary.op == "OR") {
    const Value left = eval_expr(*binary.left, schema, row);
    const Value right = eval_expr(*binary.right, schema, row);
    if (binary.op == "AND") {
      if (left.type != ValueType::Null && !truthy(left)) return Value::integer(0);
      if (right.type != ValueType::Null && !truthy(right)) {
        return Value::integer(0);
      }
      if (left.type == ValueType::Null || right.type == ValueType::Null) {
        return Value::null();
      }
      return Value::integer(1);
    }
    if (left.type != ValueType::Null && truthy(left)) return Value::integer(1);
    if (right.type != ValueType::Null && truthy(right)) {
      return Value::integer(1);
    }
    if (left.type == ValueType::Null || right.type == ValueType::Null) {
      return Value::null();
    }
    return Value::integer(0);
  }

  const Value left = eval_expr(*binary.left, schema, row);
  const Value right = eval_expr(*binary.right, schema, row);
  if (left.type == ValueType::Null || right.type == ValueType::Null) {
    return Value::null();
  }
  const int cmp = compare_values(left, right);
  bool result = false;
  if (binary.op == "=") {
    result = cmp == 0;
  } else if (binary.op == "!=" || binary.op == "<>") {
    result = cmp != 0;
  } else if (binary.op == "<") {
    result = cmp < 0;
  } else if (binary.op == "<=") {
    result = cmp <= 0;
  } else if (binary.op == ">") {
    result = cmp > 0;
  } else if (binary.op == ">=") {
    result = cmp >= 0;
  } else {
    throw std::runtime_error("unsupported operator: " + binary.op);
  }
  return Value::integer(result ? 1 : 0);
}

Value eval_expr(const Expr& expr, const TableSchema& schema, const Row& row) {
  return std::visit(
      Overloaded{
          [&](const Literal& literal) -> Value {
            if (literal.is_null) return Value::null();
            int64_t integer = 0;
            if (parse_integer_text(literal.text, integer)) {
              return Value::integer(integer);
            }
            double real = 0.0;
            if (parse_real_text(literal.text, real)) return Value::real(real);
            return Value::text(literal.text);
          },
          [&](const ColumnRef& column) -> Value {
            const int index = column_index(schema, column.name);
            if (index < 0) {
              throw std::runtime_error("unknown column: " + column.name);
            }
            if (static_cast<size_t>(index) >= row.values.size()) {
              throw std::runtime_error("row shape does not match schema");
            }
            return row.values[static_cast<size_t>(index)];
          },
          [&](const NotExpr& not_expr) -> Value {
            const Value operand = eval_expr(*not_expr.operand, schema, row);
            if (operand.type == ValueType::Null) return Value::null();
            return Value::integer(truthy(operand) ? 0 : 1);
          },
          [&](const IsNullExpr& is_null) -> Value {
            const Value operand = eval_expr(*is_null.operand, schema, row);
            bool result = operand.type == ValueType::Null;
            if (is_null.negated) result = !result;
            return Value::integer(result ? 1 : 0);
          },
          [&](const BinaryExpr& binary) -> Value {
            return eval_binary(binary, schema, row);
          },
      },
      expr.node);
}

bool matches_where(const ExprPtr& where, const TableSchema& schema,
                   const Row& row) {
  if (!where) return true;
  return truthy(eval_expr(*where, schema, row));
}

void enforce_not_null(const TableSchema& schema, const Row& row) {
  for (size_t i = 0; i < schema.columns.size(); ++i) {
    if (!schema.columns[i].not_null) continue;
    if (i < row.values.size() && row.values[i].type == ValueType::Null) {
      throw std::runtime_error("column '" + schema.columns[i].name +
                               "' cannot be NULL");
    }
  }
}

// ---------------------------------------------------------------- index plan
//
// The planner is deliberately conservative: it only looks at comparisons joined
// by AND (the shape the M1 evaluator already treats as a conjunction). OR, NOT,
// IS [NOT] NULL, != / <> and anything that is not `column OP literal` fall back
// to a full table scan, which is always correct.
//
// An index probe returns a *candidate* superset of the matching rows (see
// db/index.h: duplicates share a prefix, long TEXT/BLOB values are truncated),
// so every candidate is re-fetched and re-checked against the full WHERE
// expression. A plan can therefore make a query faster but never change its
// result.

struct IndexPlan {
  const db::IndexInfo* index = nullptr;
  db::IndexOp op = db::IndexOp::Equal;
  Value value;
};

bool is_comparison_op(std::string_view op) {
  return op == "=" || op == "!=" || op == "<>" || op == "<" || op == "<=" ||
         op == ">" || op == ">=";
}

// `literal OP column` is planned as `column FLIPPED_OP literal`.
std::string flipped_op(const std::string& op) {
  if (op == "<") return ">";
  if (op == "<=") return ">=";
  if (op == ">") return "<";
  if (op == ">=") return "<=";
  return op;  // "=", "!=", "<>"
}

struct ComparisonTerm {
  const ColumnRef* column = nullptr;
  const Literal* literal = nullptr;
  std::string op;
  bool literal_on_left = false;
};

// Collects `column OP literal` terms from an AND tree. OR is not a conjunction,
// so it is never descended into.
void collect_comparison_terms(const Expr& expr,
                              std::vector<ComparisonTerm>& out) {
  const auto* binary = std::get_if<BinaryExpr>(&expr.node);
  if (binary == nullptr) return;
  if (binary->op == "AND") {
    collect_comparison_terms(*binary->left, out);
    collect_comparison_terms(*binary->right, out);
    return;
  }
  if (!is_comparison_op(binary->op)) return;
  if (const auto* column = std::get_if<ColumnRef>(&binary->left->node)) {
    if (const auto* literal = std::get_if<Literal>(&binary->right->node)) {
      out.push_back(ComparisonTerm{column, literal, binary->op, false});
      return;
    }
  }
  if (const auto* literal = std::get_if<Literal>(&binary->left->node)) {
    if (const auto* column = std::get_if<ColumnRef>(&binary->right->node)) {
      out.push_back(ComparisonTerm{column, literal, binary->op, true});
    }
  }
}

bool looks_numeric(std::string_view text) {
  int64_t integer = 0;
  double real = 0.0;
  return parse_integer_text(text, integer) || parse_real_text(text, real);
}

// Converts the literal to the indexed column's type for a probe bound. Returns
// false when the evaluator would coerce the comparison differently from a plain
// value probe; the planner then falls back to a scan (correct, just slower).
bool literal_to_index_value(const Literal& literal, ValueType type,
                            Value& out) {
  if (literal.is_null) return false;
  switch (type) {
    case ValueType::Integer: {
      int64_t integer = 0;
      if (!parse_integer_text(literal.text, integer)) return false;
      out = Value::integer(integer);
      return true;
    }
    case ValueType::Real: {
      double real = 0.0;
      if (!parse_real_text(literal.text, real)) return false;
      out = Value::real(real);
      return true;
    }
    case ValueType::Text:
    case ValueType::Blob: {
      // eval_expr turns "123" into an INTEGER and compare_mixed() then throws
      // for a text column; keep the scan path so the error is the same.
      if (looks_numeric(literal.text)) return false;
      out = type == ValueType::Text ? Value::text(literal.text)
                                    : Value::blob(literal.text);
      return true;
    }
    case ValueType::Null:
      return false;
  }
  return false;
}

std::optional<IndexPlan> plan_index(Database& db, const std::string& table,
                                    const ExprPtr& where) {
  if (!where) return std::nullopt;
  std::vector<ComparisonTerm> terms;
  collect_comparison_terms(*where, terms);
  std::optional<IndexPlan> equality;
  std::optional<IndexPlan> range;
  for (const ComparisonTerm& term : terms) {
    const db::IndexInfo* index = db.find_index(table, term.column->name);
    if (index == nullptr) continue;
    const std::string op =
        term.literal_on_left ? flipped_op(term.op) : term.op;
    if (op == "!=" || op == "<>") continue;  // two disjoint prefix ranges
    Value value;
    if (!literal_to_index_value(*term.literal, index->type, value)) continue;
    IndexPlan plan;
    plan.index = index;
    plan.value = std::move(value);
    if (op == "=") {
      plan.op = db::IndexOp::Equal;
      if (!equality) equality = std::move(plan);
    } else if (op == "<") {
      plan.op = db::IndexOp::Less;
      if (!range) range = std::move(plan);
    } else if (op == "<=") {
      plan.op = db::IndexOp::LessEq;
      if (!range) range = std::move(plan);
    } else if (op == ">") {
      plan.op = db::IndexOp::Greater;
      if (!range) range = std::move(plan);
    } else if (op == ">=") {
      plan.op = db::IndexOp::GreaterEq;
      if (!range) range = std::move(plan);
    }
  }
  // An equality probe is always at least as selective as a range probe.
  if (equality) return equality;
  return range;
}

// Rows matching `where`, in heap order (no index) or index order (with an
// index); sets the query-plan fields on `result` when an index was used.
std::vector<std::pair<db::Rid, Row>> matching_rows(Database& db,
                                                   const std::string& table,
                                                   const TableSchema& schema,
                                                   const ExprPtr& where,
                                                   ExecResult& result) {
  const std::optional<IndexPlan> plan = plan_index(db, table, where);
  if (!plan) {
    std::vector<std::pair<db::Rid, Row>> matches;
    for (auto& entry : db.scan_rows(table)) {
      if (matches_where(where, schema, entry.second)) {
        matches.push_back(std::move(entry));
      }
    }
    return matches;
  }
  const db::FixedBTree tree(db.pager(), plan->index->root_ref());
  const std::vector<db::Rid> candidates =
      db::probe_index(tree, plan->value, plan->op);
  result.used_index = true;
  result.index_name = plan->index->name;
  std::vector<std::pair<db::Rid, Row>> matches;
  matches.reserve(candidates.size());
  for (const db::Rid& rid : candidates) {
    Row row = db.get_row(table, rid);
    if (!matches_where(where, schema, row)) continue;
    matches.emplace_back(rid, std::move(row));
  }
  return matches;
}

ExecResult exec_create(Database& db, const CreateTableStmt& stmt) {
  TableSchema schema;
  schema.name = table_key(stmt.table);
  for (const ColumnSpec& column : stmt.columns) {
    ColumnDef def;
    def.name = column.name;
    def.type = type_from_name(column.type_name);
    def.primary_key = column.primary_key;
    def.not_null = column.not_null || column.primary_key;
    schema.columns.push_back(std::move(def));
  }
  db.create_table(schema);
  return ExecResult{};
}

ExecResult exec_insert(Database& db, const InsertStmt& stmt) {
  const std::string table = table_key(stmt.table);
  const TableInfo& info = db.table_info(table);
  const TableSchema& schema = info.schema;
  const size_t column_count = schema.columns.size();

  std::vector<size_t> targets;
  if (stmt.columns.empty()) {
    for (size_t i = 0; i < column_count; ++i) targets.push_back(i);
  } else {
    for (const std::string& name : stmt.columns) {
      const int index = column_index(schema, name);
      if (index < 0) {
        throw std::runtime_error("unknown column in INSERT: " + name);
      }
      targets.push_back(static_cast<size_t>(index));
    }
  }

  ExecResult result;
  for (const std::vector<Literal>& literals : stmt.rows) {
    if (literals.size() != targets.size()) {
      throw std::runtime_error("INSERT has " + std::to_string(literals.size()) +
                               " values but expects " +
                               std::to_string(targets.size()));
    }
    Row row;
    row.values.assign(column_count, Value::null());
    for (size_t i = 0; i < literals.size(); ++i) {
      const ColumnDef& column = schema.columns[targets[i]];
      row.values[targets[i]] =
          literal_to_value(literals[i], column.type, schema, table);
    }
    enforce_not_null(schema, row);
    db.insert_row(table, row);
    ++result.affected_rows;
  }
  return result;
}

ExecResult exec_select(Database& db, const SelectStmt& stmt) {
  const std::string table = table_key(stmt.table);
  const TableInfo& info = db.table_info(table);
  const TableSchema& schema = info.schema;

  std::vector<size_t> projection;
  if (stmt.star) {
    for (size_t i = 0; i < schema.columns.size(); ++i) projection.push_back(i);
  } else {
    for (const std::string& name : stmt.columns) {
      const int index = column_index(schema, name);
      if (index < 0) {
        throw std::runtime_error("unknown column in SELECT: " + name);
      }
      projection.push_back(static_cast<size_t>(index));
    }
  }

  ExecResult result;
  for (const size_t index : projection) {
    result.columns.push_back(schema.columns[index].name);
  }
  for (const auto& [rid, row] :
       matching_rows(db, table, schema, stmt.where, result)) {
    (void)rid;
    std::vector<Value> values;
    values.reserve(projection.size());
    for (const size_t index : projection) {
      values.push_back(index < row.values.size() ? row.values[index]
                                                 : Value::null());
    }
    result.rows.push_back(std::move(values));
  }
  return result;
}

ExecResult exec_delete(Database& db, const DeleteStmt& stmt) {
  const std::string table = table_key(stmt.table);
  const TableInfo& info = db.table_info(table);
  const TableSchema& schema = info.schema;
  ExecResult result;
  const std::vector<std::pair<db::Rid, Row>> matches =
      matching_rows(db, table, schema, stmt.where, result);
  for (const auto& [rid, row] : matches) {
    (void)row;
    db.delete_row(table, rid);
  }
  result.affected_rows = matches.size();
  return result;
}

ExecResult exec_update(Database& db, const UpdateStmt& stmt) {
  const std::string table = table_key(stmt.table);
  const TableInfo& info = db.table_info(table);
  const TableSchema& schema = info.schema;
  ExecResult result;
  const std::vector<std::pair<db::Rid, Row>> matches =
      matching_rows(db, table, schema, stmt.where, result);
  std::vector<std::pair<db::Rid, Row>> updates;
  updates.reserve(matches.size());
  for (const auto& [rid, row] : matches) {
    Row updated = row;
    for (const UpdateStmt::Assign& assign : stmt.assignments) {
      const int index = column_index(schema, assign.column);
      if (index < 0) {
        throw std::runtime_error("unknown column in UPDATE: " + assign.column);
      }
      const ColumnDef& column = schema.columns[static_cast<size_t>(index)];
      updated.values[static_cast<size_t>(index)] =
          literal_to_value(assign.value, column.type, schema, table);
    }
    enforce_not_null(schema, updated);
    updates.emplace_back(rid, std::move(updated));
  }
  for (const auto& [rid, row] : updates) {
    db.update_row(table, rid, row);
  }
  result.affected_rows = updates.size();
  return result;
}

ExecResult exec_create_index(Database& db, const CreateIndexStmt& stmt) {
  db.create_index(stmt.name, table_key(stmt.table), stmt.column);
  return ExecResult{};
}

ExecResult exec_drop_index(Database& db, const DropIndexStmt& stmt) {
  db.drop_index(stmt.name);
  return ExecResult{};
}

ExecResult execute_stmt(Database& db, const Stmt& stmt) {
  return std::visit(
      Overloaded{
          [&](const CreateTableStmt& s) { return exec_create(db, s); },
          [&](const InsertStmt& s) { return exec_insert(db, s); },
          [&](const SelectStmt& s) { return exec_select(db, s); },
          [&](const DeleteStmt& s) { return exec_delete(db, s); },
          [&](const UpdateStmt& s) { return exec_update(db, s); },
          [&](const CreateIndexStmt& s) { return exec_create_index(db, s); },
          [&](const DropIndexStmt& s) { return exec_drop_index(db, s); },
      },
      stmt);
}

}  // namespace

ExecResult SqlExecutor::execute(std::string_view sql) {
  const std::vector<Stmt> statements = parse_sql(sql);
  ExecResult last;
  const bool own_transaction = !db_.in_transaction();
  if (own_transaction) db_.begin();
  try {
    for (const Stmt& statement : statements) {
      last = execute_stmt(db_, statement);
    }
    if (own_transaction) db_.commit();
  } catch (...) {
    if (own_transaction) {
      try {
        db_.rollback();
      } catch (...) {
      }
    }
    throw;
  }
  return last;
}

}  // namespace iaqs::sql
