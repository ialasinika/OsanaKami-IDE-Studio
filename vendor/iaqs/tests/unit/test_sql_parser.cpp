// Unit tests for the iaqs SQL front end: lexer, parser and AST shape.
//
// These tests only exercise parsing (no execution/storage). They intentionally
// spell out the AST structure so the contract in src/sql/ast.h stays stable.
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

#include "harness.h"
#include "sql/ast.h"
#include "sql/parser.h"

namespace {

using iaqs::sql::BinaryExpr;
using iaqs::sql::ColumnRef;
using iaqs::sql::CreateTableStmt;
using iaqs::sql::DeleteStmt;
using iaqs::sql::InsertStmt;
using iaqs::sql::IsNullExpr;
using iaqs::sql::Literal;
using iaqs::sql::NotExpr;
using iaqs::sql::SelectStmt;
using iaqs::sql::Stmt;
using iaqs::sql::UpdateStmt;

std::vector<Stmt> parse(std::string_view sql) { return iaqs::sql::parse_sql(sql); }

}  // namespace

// ---------------------------------------------------------------- empty input
IAQS_TEST(sql_parser, empty_and_comment_only_input) {
  CHECK(parse("").empty());
  CHECK(parse("   \n\t\r\n  ").empty());
  CHECK(parse("-- just a comment").empty());
  CHECK(parse("-- one\n   -- two\n\n").empty());
  CHECK(parse(";;;").empty());
  CHECK(parse(" ; ; -- trailing\n ;").empty());
}

// ------------------------------------------------------------- CREATE TABLE
IAQS_TEST(sql_parser, create_table_all_types) {
  const auto stmts = parse(
      "CREATE TABLE widgets (\n"
      "  id INTEGER PRIMARY KEY,\n"
      "  price REAL NOT NULL,\n"
      "  name TEXT,\n"
      "  payload BLOB\n"
      ");");
  CHECK_EQ(stmts.size(), 1u);
  const auto& create = std::get<CreateTableStmt>(stmts[0]);
  CHECK_EQ(create.table, "widgets");
  CHECK_EQ(create.columns.size(), 4u);

  CHECK_EQ(create.columns[0].name, "id");
  CHECK_EQ(create.columns[0].type_name, "INTEGER");
  CHECK(create.columns[0].primary_key);
  CHECK(!create.columns[0].not_null);

  CHECK_EQ(create.columns[1].name, "price");
  CHECK_EQ(create.columns[1].type_name, "REAL");
  CHECK(!create.columns[1].primary_key);
  CHECK(create.columns[1].not_null);

  CHECK_EQ(create.columns[2].name, "name");
  CHECK_EQ(create.columns[2].type_name, "TEXT");
  CHECK(!create.columns[2].primary_key);
  CHECK(!create.columns[2].not_null);

  CHECK_EQ(create.columns[3].name, "payload");
  CHECK_EQ(create.columns[3].type_name, "BLOB");
}

IAQS_TEST(sql_parser, create_table_flags_any_order) {
  // NOT NULL before PRIMARY KEY is accepted; both flags can be set.
  const auto stmts = parse(
      "CREATE TABLE t (id INTEGER NOT NULL PRIMARY KEY, note TEXT NOT NULL);");
  const auto& create = std::get<CreateTableStmt>(stmts[0]);
  CHECK(create.columns[0].primary_key);
  CHECK(create.columns[0].not_null);
  CHECK(!create.columns[1].primary_key);
  CHECK(create.columns[1].not_null);
}

// ------------------------------------------------------------------- INSERT
IAQS_TEST(sql_parser, insert_multi_row_multi_column) {
  const auto stmts = parse(
      "INSERT INTO t (a, b, c) VALUES (1, 2.5, 'x'), (-3, NULL, 'it''s');");
  CHECK_EQ(stmts.size(), 1u);
  const auto& insert = std::get<InsertStmt>(stmts[0]);
  CHECK_EQ(insert.table, "t");
  CHECK_EQ(insert.columns.size(), 3u);
  CHECK_EQ(insert.columns[0], "a");
  CHECK_EQ(insert.columns[1], "b");
  CHECK_EQ(insert.columns[2], "c");
  CHECK_EQ(insert.rows.size(), 2u);

  CHECK_EQ(insert.rows[0].size(), 3u);
  CHECK_EQ(insert.rows[0][0].text, "1");
  CHECK(!insert.rows[0][0].is_null);
  CHECK_EQ(insert.rows[0][1].text, "2.5");
  CHECK_EQ(insert.rows[0][2].text, "x");

  CHECK_EQ(insert.rows[1].size(), 3u);
  CHECK_EQ(insert.rows[1][0].text, "-3");
  CHECK(insert.rows[1][1].is_null);
  CHECK(insert.rows[1][1].text.empty());
  CHECK_EQ(insert.rows[1][2].text, "it's");
}

IAQS_TEST(sql_parser, insert_without_column_list) {
  const auto stmts = parse("INSERT INTO t VALUES (1, 'a'), (2, 'b');");
  const auto& insert = std::get<InsertStmt>(stmts[0]);
  CHECK(insert.columns.empty());
  CHECK_EQ(insert.rows.size(), 2u);
  CHECK_EQ(insert.rows[0].size(), 2u);
  CHECK_EQ(insert.rows[1][0].text, "2");
  CHECK_EQ(insert.rows[1][1].text, "b");
}

IAQS_TEST(sql_parser, insert_string_escapes) {
  const auto stmts = parse(
      "INSERT INTO t VALUES ('a''''b', '''', '', 'ends with quote''');");
  const auto& insert = std::get<InsertStmt>(stmts[0]);
  CHECK_EQ(insert.rows.size(), 1u);
  CHECK_EQ(insert.rows[0].size(), 4u);
  CHECK_EQ(insert.rows[0][0].text, "a''b");
  CHECK_EQ(insert.rows[0][1].text, "'");
  CHECK_EQ(insert.rows[0][2].text, "");
  CHECK_EQ(insert.rows[0][3].text, "ends with quote'");
}

IAQS_TEST(sql_parser, negative_number_literals) {
  const auto stmts = parse("INSERT INTO t VALUES (-42, -3.5);");
  const auto& insert = std::get<InsertStmt>(stmts[0]);
  CHECK_EQ(insert.rows[0][0].text, "-42");
  CHECK_EQ(insert.rows[0][1].text, "-3.5");
}

// ------------------------------------------------------------------- SELECT
IAQS_TEST(sql_parser, select_star) {
  const auto stmts = parse("SELECT * FROM t;");
  CHECK_EQ(stmts.size(), 1u);
  const auto& select = std::get<SelectStmt>(stmts[0]);
  CHECK(select.star);
  CHECK(select.columns.empty());
  CHECK_EQ(select.table, "t");
  CHECK(select.where == nullptr);
}

IAQS_TEST(sql_parser, select_column_list) {
  const auto stmts = parse("SELECT a, b, c FROM t;");
  const auto& select = std::get<SelectStmt>(stmts[0]);
  CHECK(!select.star);
  CHECK_EQ(select.columns.size(), 3u);
  CHECK_EQ(select.columns[0], "a");
  CHECK_EQ(select.columns[1], "b");
  CHECK_EQ(select.columns[2], "c");
  CHECK_EQ(select.table, "t");
}

IAQS_TEST(sql_parser, select_where_precedence) {
  // OR < AND < NOT < comparison; IS NULL binds tighter than a comparison.
  const auto stmts = parse(
      "SELECT * FROM t WHERE a = 1 OR b = 2 AND NOT c IS NULL;");
  const auto& select = std::get<SelectStmt>(stmts[0]);
  CHECK(select.where != nullptr);

  const auto& root = std::get<BinaryExpr>(select.where->node);
  CHECK_EQ(root.op, "OR");
  const auto& left = std::get<BinaryExpr>(root.left->node);
  CHECK_EQ(left.op, "=");
  CHECK_EQ(std::get<ColumnRef>(left.left->node).name, "a");
  CHECK_EQ(std::get<Literal>(left.right->node).text, "1");

  const auto& right = std::get<BinaryExpr>(root.right->node);
  CHECK_EQ(right.op, "AND");
  const auto& cmp = std::get<BinaryExpr>(right.left->node);
  CHECK_EQ(cmp.op, "=");
  CHECK_EQ(std::get<ColumnRef>(cmp.left->node).name, "b");
  CHECK_EQ(std::get<Literal>(cmp.right->node).text, "2");
  const auto& not_node = std::get<NotExpr>(right.right->node);
  const auto& is_null = std::get<IsNullExpr>(not_node.operand->node);
  CHECK(!is_null.negated);
  CHECK_EQ(std::get<ColumnRef>(is_null.operand->node).name, "c");
}

IAQS_TEST(sql_parser, select_where_parentheses) {
  const auto stmts = parse(
      "SELECT * FROM t WHERE (a = 1 OR b <> 2) AND c >= 3;");
  const auto& select = std::get<SelectStmt>(stmts[0]);
  const auto& root = std::get<BinaryExpr>(select.where->node);
  CHECK_EQ(root.op, "AND");
  const auto& left = std::get<BinaryExpr>(root.left->node);
  CHECK_EQ(left.op, "OR");
  const auto& inner_left = std::get<BinaryExpr>(left.left->node);
  CHECK_EQ(inner_left.op, "=");
  const auto& inner_right = std::get<BinaryExpr>(left.right->node);
  CHECK_EQ(inner_right.op, "<>");
  CHECK_EQ(std::get<ColumnRef>(inner_right.left->node).name, "b");
  CHECK_EQ(std::get<Literal>(inner_right.right->node).text, "2");
  const auto& right = std::get<BinaryExpr>(root.right->node);
  CHECK_EQ(right.op, ">=");
  CHECK_EQ(std::get<ColumnRef>(right.left->node).name, "c");
  CHECK_EQ(std::get<Literal>(right.right->node).text, "3");
}

IAQS_TEST(sql_parser, select_where_is_null_forms) {
  const auto stmts = parse(
      "SELECT * FROM t WHERE a IS NULL;\n"
      "SELECT * FROM t WHERE a IS NOT NULL;\n"
      "SELECT * FROM t WHERE NOT a IS NULL;\n"
      "SELECT * FROM t WHERE a = b IS NULL;");
  CHECK_EQ(stmts.size(), 4u);

  {
    const auto& select = std::get<SelectStmt>(stmts[0]);
    const auto& is_null = std::get<IsNullExpr>(select.where->node);
    CHECK(!is_null.negated);
    CHECK_EQ(std::get<ColumnRef>(is_null.operand->node).name, "a");
  }
  {
    const auto& select = std::get<SelectStmt>(stmts[1]);
    const auto& is_null = std::get<IsNullExpr>(select.where->node);
    CHECK(is_null.negated);
    CHECK_EQ(std::get<ColumnRef>(is_null.operand->node).name, "a");
  }
  {
    const auto& select = std::get<SelectStmt>(stmts[2]);
    const auto& not_node = std::get<NotExpr>(select.where->node);
    const auto& is_null = std::get<IsNullExpr>(not_node.operand->node);
    CHECK(!is_null.negated);
  }
  {
    // `=` has lower precedence than IS NULL: a = (b IS NULL).
    const auto& select = std::get<SelectStmt>(stmts[3]);
    const auto& root = std::get<BinaryExpr>(select.where->node);
    CHECK_EQ(root.op, "=");
    CHECK_EQ(std::get<ColumnRef>(root.left->node).name, "a");
    CHECK(std::holds_alternative<IsNullExpr>(root.right->node));
  }
}

IAQS_TEST(sql_parser, select_where_comparison_operators) {
  const std::vector<std::string> ops = {"=", "!=", "<>", "<", "<=", ">", ">="};
  for (const std::string& op : ops) {
    const auto stmts = parse("SELECT * FROM t WHERE a " + op + " b;");
    const auto& select = std::get<SelectStmt>(stmts[0]);
    const auto& binary = std::get<BinaryExpr>(select.where->node);
    CHECK_EQ(binary.op, op);
    CHECK_EQ(std::get<ColumnRef>(binary.left->node).name, "a");
    CHECK_EQ(std::get<ColumnRef>(binary.right->node).name, "b");
  }
}

IAQS_TEST(sql_parser, select_where_literal_comparison) {
  const auto stmts = parse(
      "SELECT * FROM t WHERE price < 9.99 AND name = 'bob';");
  const auto& select = std::get<SelectStmt>(stmts[0]);
  const auto& root = std::get<BinaryExpr>(select.where->node);
  CHECK_EQ(root.op, "AND");
  const auto& price = std::get<BinaryExpr>(root.left->node);
  CHECK_EQ(std::get<Literal>(price.right->node).text, "9.99");
  const auto& name = std::get<BinaryExpr>(root.right->node);
  CHECK_EQ(std::get<Literal>(name.right->node).text, "bob");
}

// --------------------------------------------------------- UPDATE / DELETE
IAQS_TEST(sql_parser, update_with_where) {
  const auto stmts = parse(
      "UPDATE t SET a = 1, b = 'z', c = NULL WHERE d = 2;");
  CHECK_EQ(stmts.size(), 1u);
  const auto& update = std::get<UpdateStmt>(stmts[0]);
  CHECK_EQ(update.table, "t");
  CHECK_EQ(update.assignments.size(), 3u);
  CHECK_EQ(update.assignments[0].column, "a");
  CHECK_EQ(update.assignments[0].value.text, "1");
  CHECK_EQ(update.assignments[1].column, "b");
  CHECK_EQ(update.assignments[1].value.text, "z");
  CHECK_EQ(update.assignments[2].column, "c");
  CHECK(update.assignments[2].value.is_null);

  CHECK(update.where != nullptr);
  const auto& where = std::get<BinaryExpr>(update.where->node);
  CHECK_EQ(where.op, "=");
  CHECK_EQ(std::get<ColumnRef>(where.left->node).name, "d");
  CHECK_EQ(std::get<Literal>(where.right->node).text, "2");
}

IAQS_TEST(sql_parser, update_and_delete_without_where) {
  const auto stmts = parse("UPDATE t SET a = 1; DELETE FROM t;");
  CHECK_EQ(stmts.size(), 2u);
  const auto& update = std::get<UpdateStmt>(stmts[0]);
  CHECK(update.where == nullptr);
  const auto& remove = std::get<DeleteStmt>(stmts[1]);
  CHECK_EQ(remove.table, "t");
  CHECK(remove.where == nullptr);
}

IAQS_TEST(sql_parser, delete_with_where) {
  const auto stmts = parse("DELETE FROM t WHERE a < 10;");
  const auto& remove = std::get<DeleteStmt>(stmts[0]);
  CHECK_EQ(remove.table, "t");
  CHECK(remove.where != nullptr);
  const auto& where = std::get<BinaryExpr>(remove.where->node);
  CHECK_EQ(where.op, "<");
  CHECK_EQ(std::get<Literal>(where.right->node).text, "10");
}

// ------------------------------------------------------- statements + lexing
IAQS_TEST(sql_parser, multiple_statements_and_separators) {
  const auto stmts = parse(
      "CREATE TABLE t (a INTEGER);\n"
      "INSERT INTO t VALUES (1);\n"
      "SELECT * FROM t;\n"
      "UPDATE t SET a = 2 WHERE a = 1;\n"
      "DELETE FROM t WHERE a = 2;");
  CHECK_EQ(stmts.size(), 5u);
  CHECK(std::holds_alternative<CreateTableStmt>(stmts[0]));
  CHECK(std::holds_alternative<InsertStmt>(stmts[1]));
  CHECK(std::holds_alternative<SelectStmt>(stmts[2]));
  CHECK(std::holds_alternative<UpdateStmt>(stmts[3]));
  CHECK(std::holds_alternative<DeleteStmt>(stmts[4]));

  // The last statement may omit its terminating ';' and empty statements are
  // tolerated.
  CHECK_EQ(parse("SELECT * FROM t").size(), 1u);
  CHECK_EQ(parse(";; SELECT * FROM t ;;").size(), 1u);
}

IAQS_TEST(sql_parser, keywords_case_insensitive_identifiers_preserved) {
  const auto stmts = parse(
      "CrEaTe TaBlE Widgets (Id InTeGeR PrImArY kEy, Name TeXt);\n"
      "sElEcT * FrOm Widgets WhErE Id = 1;\n"
      "DeLeTe FrOm Widgets WhErE Id iS nOt NuLl;");
  CHECK_EQ(stmts.size(), 3u);
  const auto& create = std::get<CreateTableStmt>(stmts[0]);
  CHECK_EQ(create.table, "Widgets");
  CHECK_EQ(create.columns[0].name, "Id");
  CHECK_EQ(create.columns[0].type_name, "INTEGER");
  CHECK(create.columns[0].primary_key);
  CHECK_EQ(create.columns[1].name, "Name");
  CHECK_EQ(create.columns[1].type_name, "TEXT");

  const auto& select = std::get<SelectStmt>(stmts[1]);
  CHECK_EQ(select.table, "Widgets");
  const auto& where = std::get<BinaryExpr>(select.where->node);
  CHECK_EQ(std::get<ColumnRef>(where.left->node).name, "Id");

  const auto& remove = std::get<DeleteStmt>(stmts[2]);
  const auto& is_null = std::get<IsNullExpr>(remove.where->node);
  CHECK(is_null.negated);
}

IAQS_TEST(sql_parser, line_comments) {
  const std::string sql =
      "-- leading comment\n"
      "CREATE TABLE t (a INTEGER); -- trailing comment\n"
      "  -- indented comment\n"
      "INSERT INTO t VALUES (1);\n"
      "-- final comment without a trailing newline";
  const auto stmts = parse(sql);
  CHECK_EQ(stmts.size(), 2u);
  CHECK(std::holds_alternative<CreateTableStmt>(stmts[0]));
  CHECK(std::holds_alternative<InsertStmt>(stmts[1]));
}

IAQS_TEST(sql_parser, lexer_token_stream) {
  const auto tokens = iaqs::sql::tokenize("SELECT x--comment\nFROM t");
  CHECK_EQ(tokens.size(), 5u);  // SELECT x FROM t END
  CHECK(tokens[0].kind == iaqs::sql::TokenKind::Identifier);
  CHECK_EQ(tokens[0].text, "SELECT");
  CHECK_EQ(tokens[0].line, 1);
  CHECK_EQ(tokens[0].col, 1);
  CHECK_EQ(tokens[1].text, "x");
  CHECK_EQ(tokens[1].col, 8);
  CHECK_EQ(tokens[2].text, "FROM");
  CHECK_EQ(tokens[2].line, 2);
  CHECK_EQ(tokens[3].text, "t");
  CHECK(tokens[4].kind == iaqs::sql::TokenKind::End);

  const auto strings = iaqs::sql::tokenize("'a''b'");
  CHECK_EQ(strings.size(), 2u);
  CHECK(strings[0].kind == iaqs::sql::TokenKind::String);
  CHECK_EQ(strings[0].text, "a'b");

  const auto numbers = iaqs::sql::tokenize("42 3.14");
  CHECK_EQ(numbers.size(), 3u);
  CHECK(numbers[0].kind == iaqs::sql::TokenKind::Number);
  CHECK_EQ(numbers[0].text, "42");
  CHECK_EQ(numbers[1].text, "3.14");
}

// ------------------------------------------------------------------- errors
IAQS_TEST(sql_parser, rejects_invalid_input) {
  // Unknown column type.
  CHECK_THROW(parse("CREATE TABLE t (a FLOAT);"), std::runtime_error);
  // Missing ')' / stray ',' / empty column list.
  CHECK_THROW(parse("CREATE TABLE t (a INTEGER;"), std::runtime_error);
  CHECK_THROW(parse("CREATE TABLE t (a INTEGER,);"), std::runtime_error);
  CHECK_THROW(parse("CREATE TABLE t ();"), std::runtime_error);
  // Missing or malformed VALUES, non-literal values, unterminated string.
  CHECK_THROW(parse("INSERT INTO t (a, b);"), std::runtime_error);
  CHECK_THROW(parse("INSERT INTO t VALUES;"), std::runtime_error);
  CHECK_THROW(parse("INSERT INTO t VALUES (a);"), std::runtime_error);
  CHECK_THROW(parse("INSERT INTO t VALUES ('abc);"), std::runtime_error);
  // Broken WHERE expressions.
  CHECK_THROW(parse("SELECT * FROM t WHERE a = ;"), std::runtime_error);
  CHECK_THROW(parse("SELECT * FROM t WHERE a = 1 AND;"), std::runtime_error);
  CHECK_THROW(parse("SELECT * FROM t WHERE (a = 1;"), std::runtime_error);
  CHECK_THROW(parse("SELECT * FROM t WHERE a = 1 = 2;"), std::runtime_error);
  // Missing clauses / names.
  CHECK_THROW(parse("SELECT * FROM;"), std::runtime_error);
  CHECK_THROW(parse("SELECT a, FROM t;"), std::runtime_error);
  CHECK_THROW(parse("SELECT *, a FROM t;"), std::runtime_error);
  CHECK_THROW(parse("DELETE t WHERE a = 1;"), std::runtime_error);
  CHECK_THROW(parse("UPDATE t a = 1;"), std::runtime_error);
  CHECK_THROW(parse("UPDATE t SET a = 1 WHERE;"), std::runtime_error);
  CHECK_THROW(parse("UPDATE t SET a = b WHERE c = 1;"), std::runtime_error);
  // Unknown statement keyword, garbage after a statement, illegal characters.
  CHECK_THROW(parse("SELEC * FROM t;"), std::runtime_error);
  CHECK_THROW(parse("SELECT * FROM t; garbage"), std::runtime_error);
  CHECK_THROW(parse("CREATE TABLE t (a INTEGER) );"), std::runtime_error);
  CHECK_THROW(parse("SELECT * FROM t WHERE a @ 1;"), std::runtime_error);
  CHECK_THROW(parse("SELECT * FROM t WHERE a = 'x'!;"), std::runtime_error);
  CHECK_THROW(parse("INSERT INTO t VALUES (1) ?"), std::runtime_error);
}

IAQS_TEST(sql_parser, error_messages_carry_position_and_expectation) {
  try {
    (void)parse("SELECT *\nFROM;");
    CHECK(false);  // the input above must not parse
  } catch (const std::runtime_error& error) {
    const std::string message = error.what();
    // The missing table name is reported at line 2, column 5: "2:5: expected
    // table name, found ';'".
    CHECK_EQ(message.compare(0, 2, "2:"), 0);
    CHECK(message.find("expected") != std::string::npos);
    CHECK(message.find("table name") != std::string::npos);
  }

  try {
    (void)iaqs::sql::tokenize("SELECT a\n  @");
    CHECK(false);  // '@' is not a valid SQL character
  } catch (const std::runtime_error& error) {
    const std::string message = error.what();
    CHECK_EQ(message.compare(0, 2, "2:"), 0);
    CHECK(message.find("unexpected character") != std::string::npos);
  }
}
