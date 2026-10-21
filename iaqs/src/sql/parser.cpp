// iaqs SQL front end: lexer + recursive-descent parser for the M1/M2 subset.
//
// Grammar (keywords case-insensitive, identifiers keep their spelling):
//   statements := statement (';' statements?)*
//   CREATE TABLE name (col TYPE [PRIMARY KEY] [NOT NULL], ...)
//   CREATE INDEX name ON table (column)
//   DROP INDEX name
//   INSERT INTO name [(col, ...)] VALUES (lit, ...), (...)
//   SELECT ('*' | col, ...) FROM name [WHERE expr]
//   DELETE FROM name [WHERE expr]
//   UPDATE name SET col = lit, ... [WHERE expr]
//   expr := and (OR and)*
//   and  := not (AND not)*
//   not  := NOT not | cmp
//   cmp  := isnull [('='|'!='|'<>'|'<'|'<='|'>'|'>=') isnull]
//   isnull := primary (IS [NOT] NULL)*
//   primary := '(' expr ')' | literal | '-' number | column | NULL
//   literal := number | string
#include "sql/parser.h"

#include <cstddef>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "core/util.h"

namespace iaqs::sql {
namespace {

bool is_space(char c) {
  return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\f' ||
         c == '\v';
}

bool is_digit(char c) { return c >= '0' && c <= '9'; }

bool is_ident_start(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
}

bool is_ident_char(char c) { return is_ident_start(c) || is_digit(c); }

[[noreturn]] void lex_error(int line, int col, std::string_view message) {
  throw std::runtime_error(std::to_string(line) + ":" + std::to_string(col) +
                           ": " + std::string(message));
}

std::string describe_token(const Token& token) {
  switch (token.kind) {
    case TokenKind::End:
      return "end of input";
    case TokenKind::String:
      return "string literal";
    default:
      break;
  }
  return "'" + token.text + "'";
}

std::string unexpected_char_message(char c) {
  std::string message = "unexpected character '";
  message.push_back(c);
  message += "'";
  return message;
}

}  // namespace

std::vector<Token> tokenize(std::string_view text) {
  std::vector<Token> tokens;
  std::size_t i = 0;
  int line = 1;
  int col = 1;
  const auto advance_char = [&]() {
    if (text[i] == '\n') {
      ++line;
      col = 1;
    } else {
      ++col;
    }
    ++i;
  };

  while (i < text.size()) {
    const char c = text[i];
    if (is_space(c)) {
      advance_char();
      continue;
    }
    // `--` starts a comment that runs to the end of the line.
    if (c == '-' && i + 1 < text.size() && text[i + 1] == '-') {
      while (i < text.size() && text[i] != '\n') advance_char();
      continue;
    }

    const int token_line = line;
    const int token_col = col;

    if (is_ident_start(c)) {
      std::string ident;
      while (i < text.size() && is_ident_char(text[i])) {
        ident.push_back(text[i]);
        advance_char();
      }
      tokens.push_back(
          Token{TokenKind::Identifier, std::move(ident), token_line, token_col});
      continue;
    }

    if (is_digit(c)) {
      std::string number;
      while (i < text.size() && is_digit(text[i])) {
        number.push_back(text[i]);
        advance_char();
      }
      if (i < text.size() && text[i] == '.') {
        number.push_back('.');
        advance_char();
        if (i >= text.size() || !is_digit(text[i])) {
          lex_error(token_line, token_col, "expected digits after '.' in number");
        }
        while (i < text.size() && is_digit(text[i])) {
          number.push_back(text[i]);
          advance_char();
        }
      }
      tokens.push_back(
          Token{TokenKind::Number, std::move(number), token_line, token_col});
      continue;
    }

    if (c == '\'') {
      std::string value;
      advance_char();  // opening quote
      bool closed = false;
      while (i < text.size()) {
        if (text[i] == '\'') {
          if (i + 1 < text.size() && text[i + 1] == '\'') {
            value.push_back('\'');  // SQL escape: '' is one quote
            advance_char();
            advance_char();
            continue;
          }
          advance_char();  // closing quote
          closed = true;
          break;
        }
        value.push_back(text[i]);
        advance_char();
      }
      if (!closed) lex_error(token_line, token_col, "unterminated string literal");
      tokens.push_back(
          Token{TokenKind::String, std::move(value), token_line, token_col});
      continue;
    }

    const bool has_next = i + 1 < text.size();
    switch (c) {
      case '(':
      case ')':
      case ',':
      case ';':
      case '*':
      case '=':
      case '-':
        tokens.push_back(
            Token{TokenKind::Punct, std::string(1, c), token_line, token_col});
        advance_char();
        continue;
      case '!':
        if (has_next && text[i + 1] == '=') {
          tokens.push_back(Token{TokenKind::Punct, "!=", token_line, token_col});
          advance_char();
          advance_char();
          continue;
        }
        lex_error(token_line, token_col, "unexpected character '!' (did you mean '!='?)");
      case '<':
        if (has_next && text[i + 1] == '=') {
          tokens.push_back(Token{TokenKind::Punct, "<=", token_line, token_col});
          advance_char();
          advance_char();
          continue;
        }
        if (has_next && text[i + 1] == '>') {
          tokens.push_back(Token{TokenKind::Punct, "<>", token_line, token_col});
          advance_char();
          advance_char();
          continue;
        }
        tokens.push_back(Token{TokenKind::Punct, "<", token_line, token_col});
        advance_char();
        continue;
      case '>':
        if (has_next && text[i + 1] == '=') {
          tokens.push_back(Token{TokenKind::Punct, ">=", token_line, token_col});
          advance_char();
          advance_char();
          continue;
        }
        tokens.push_back(Token{TokenKind::Punct, ">", token_line, token_col});
        advance_char();
        continue;
      default:
        lex_error(token_line, token_col, unexpected_char_message(c));
    }
  }

  tokens.push_back(Token{TokenKind::End, std::string(), line, col});
  return tokens;
}

namespace {

ExprPtr make_expr(Literal node) {
  auto expr = std::make_unique<Expr>();
  expr->node = std::move(node);
  return expr;
}

ExprPtr make_expr(ColumnRef node) {
  auto expr = std::make_unique<Expr>();
  expr->node = std::move(node);
  return expr;
}

ExprPtr make_expr(BinaryExpr node) {
  auto expr = std::make_unique<Expr>();
  expr->node = std::move(node);
  return expr;
}

ExprPtr make_expr(NotExpr node) {
  auto expr = std::make_unique<Expr>();
  expr->node = std::move(node);
  return expr;
}

ExprPtr make_expr(IsNullExpr node) {
  auto expr = std::make_unique<Expr>();
  expr->node = std::move(node);
  return expr;
}

bool is_comparison_op(std::string_view text) {
  return text == "=" || text == "!=" || text == "<>" || text == "<" ||
         text == "<=" || text == ">" || text == ">=";
}

class Parser {
 public:
  explicit Parser(std::vector<Token> tokens) : tokens_(std::move(tokens)) {}

  std::vector<Stmt> parse_statements() {
    std::vector<Stmt> statements;
    for (;;) {
      while (check_punct(";")) advance();  // tolerate empty statements
      if (at_end()) break;
      statements.push_back(parse_statement());
      if (check_punct(";")) {
        advance();
        continue;
      }
      if (at_end()) break;
      fail("expected ';' or end of input after statement");
    }
    return statements;
  }

 private:
  // ------------------------------------------------------------- token access
  const Token& peek(std::size_t ahead = 0) const {
    const std::size_t index = pos_ + ahead;
    return index < tokens_.size() ? tokens_[index] : tokens_.back();
  }

  bool at_end() const { return peek().kind == TokenKind::End; }

  const Token& advance() {
    const Token& token = peek();
    if (!at_end()) ++pos_;
    return token;
  }

  bool check_punct(std::string_view text) const {
    const Token& token = peek();
    return token.kind == TokenKind::Punct && token.text == text;
  }

  bool match_punct(std::string_view text) {
    if (!check_punct(text)) return false;
    advance();
    return true;
  }

  bool check_keyword(std::string_view keyword) const {
    const Token& token = peek();
    return token.kind == TokenKind::Identifier &&
           iaqs::to_lower_ascii(token.text) == keyword;
  }

  bool match_keyword(std::string_view keyword) {
    if (!check_keyword(keyword)) return false;
    advance();
    return true;
  }

  void expect_punct(std::string_view text, std::string_view where) {
    if (!match_punct(text)) {
      fail("expected '" + std::string(text) + "' " + std::string(where));
    }
  }

  void expect_keyword(std::string_view keyword) {
    if (!match_keyword(keyword)) fail("expected " + std::string(keyword));
  }

  std::string expect_identifier(std::string_view what) {
    if (peek().kind != TokenKind::Identifier) {
      fail("expected " + std::string(what));
    }
    return advance().text;
  }

  [[noreturn]] void fail(std::string_view expectation) const {
    const Token& token = peek();
    throw std::runtime_error(std::to_string(token.line) + ":" +
                             std::to_string(token.col) + ": expected " +
                             std::string(expectation) + ", found " +
                             describe_token(token));
  }

  // ------------------------------------------------------------- statements
  Stmt parse_statement() {
    if (check_keyword("create")) {
      advance();  // CREATE
      if (match_keyword("index")) return parse_create_index();
      return parse_create_table();
    }
    if (check_keyword("insert")) return parse_insert();
    if (check_keyword("select")) return parse_select();
    if (check_keyword("delete")) return parse_delete();
    if (check_keyword("drop")) {
      advance();  // DROP
      return parse_drop_index();
    }
    if (check_keyword("update")) return parse_update();
    fail("expected CREATE, INSERT, SELECT, DELETE, DROP or UPDATE");
  }

  Stmt parse_create_table() {
    expect_keyword("table");
    CreateTableStmt statement;
    statement.table = expect_identifier("table name");
    expect_punct("(", "after table name");
    if (check_punct(")")) fail("expected a column definition");
    for (;;) {
      statement.columns.push_back(parse_column_spec());
      if (match_punct(",")) continue;
      break;
    }
    expect_punct(")", "to close the column list");
    return statement;
  }

  // CREATE INDEX name ON table (column)
  Stmt parse_create_index() {
    CreateIndexStmt statement;
    statement.name = expect_identifier("index name");
    expect_keyword("on");
    statement.table = expect_identifier("table name");
    expect_punct("(", "after table name");
    statement.column = expect_identifier("column name");
    expect_punct(")", "to close the column list");
    return statement;
  }

  // DROP INDEX name
  Stmt parse_drop_index() {
    expect_keyword("index");
    DropIndexStmt statement;
    statement.name = expect_identifier("index name");
    return statement;
  }

  ColumnSpec parse_column_spec() {
    ColumnSpec column;
    column.name = expect_identifier("column name");
    if (peek().kind != TokenKind::Identifier) {
      fail("expected a column type (INTEGER, REAL, TEXT or BLOB)");
    }
    const std::string type = iaqs::to_lower_ascii(peek().text);
    if (type == "integer") {
      column.type_name = "INTEGER";
    } else if (type == "real") {
      column.type_name = "REAL";
    } else if (type == "text") {
      column.type_name = "TEXT";
    } else if (type == "blob") {
      column.type_name = "BLOB";
    } else {
      fail("expected a column type (INTEGER, REAL, TEXT or BLOB)");
    }
    advance();
    for (;;) {
      if (match_keyword("primary")) {
        expect_keyword("key");
        column.primary_key = true;
      } else if (match_keyword("not")) {
        expect_keyword("null");
        column.not_null = true;
      } else {
        break;
      }
    }
    return column;
  }

  Stmt parse_insert() {
    advance();  // INSERT
    expect_keyword("into");
    InsertStmt statement;
    statement.table = expect_identifier("table name");
    if (check_punct("(")) {
      advance();
      for (;;) {
        statement.columns.push_back(expect_identifier("column name"));
        if (match_punct(",")) continue;
        break;
      }
      expect_punct(")", "to close the column list");
    }
    expect_keyword("values");
    for (;;) {
      expect_punct("(", "before a VALUES row");
      std::vector<Literal> row;
      for (;;) {
        row.push_back(parse_literal_value());
        if (match_punct(",")) continue;
        break;
      }
      expect_punct(")", "to close a VALUES row");
      statement.rows.push_back(std::move(row));
      if (match_punct(",")) continue;
      break;
    }
    return statement;
  }

  Stmt parse_select() {
    advance();  // SELECT
    SelectStmt statement;
    if (match_punct("*")) {
      statement.star = true;
    } else {
      statement.star = false;
      for (;;) {
        statement.columns.push_back(expect_identifier("column name or '*'"));
        if (match_punct(",")) continue;
        break;
      }
    }
    expect_keyword("from");
    statement.table = expect_identifier("table name");
    if (match_keyword("where")) statement.where = parse_or_expr();
    return statement;
  }

  Stmt parse_delete() {
    advance();  // DELETE
    expect_keyword("from");
    DeleteStmt statement;
    statement.table = expect_identifier("table name");
    if (match_keyword("where")) statement.where = parse_or_expr();
    return statement;
  }

  Stmt parse_update() {
    advance();  // UPDATE
    UpdateStmt statement;
    statement.table = expect_identifier("table name");
    expect_keyword("set");
    for (;;) {
      UpdateStmt::Assign assignment;
      assignment.column = expect_identifier("column name");
      expect_punct("=", "after the column name");
      assignment.value = parse_literal_value();
      statement.assignments.push_back(std::move(assignment));
      if (match_punct(",")) continue;
      break;
    }
    if (match_keyword("where")) statement.where = parse_or_expr();
    return statement;
  }

  // -------------------------------------------------------------- literals
  // M1 accepts only literals in VALUES / SET; numbers keep their source text
  // (including a leading '-') and strings arrive already unescaped.
  Literal parse_literal_value() {
    const Token& token = peek();
    if (token.kind == TokenKind::Punct && token.text == "-") {
      advance();
      if (peek().kind != TokenKind::Number) {
        fail("expected a number after '-'");
      }
      const Token& number = advance();
      Literal literal;
      literal.text = "-" + number.text;
      return literal;
    }
    if (token.kind == TokenKind::Number || token.kind == TokenKind::String) {
      Literal literal;
      literal.text = advance().text;
      return literal;
    }
    if (token.kind == TokenKind::Identifier &&
        iaqs::to_lower_ascii(token.text) == "null") {
      advance();
      Literal literal;
      literal.is_null = true;
      return literal;
    }
    fail("expected a literal (number, string or NULL)");
  }

  // ----------------------------------------------------------- expressions
  ExprPtr parse_or_expr() {
    ExprPtr left = parse_and_expr();
    while (match_keyword("or")) {
      ExprPtr right = parse_and_expr();
      left = make_expr(BinaryExpr{std::move(left), "OR", std::move(right)});
    }
    return left;
  }

  ExprPtr parse_and_expr() {
    ExprPtr left = parse_not_expr();
    while (match_keyword("and")) {
      ExprPtr right = parse_not_expr();
      left = make_expr(BinaryExpr{std::move(left), "AND", std::move(right)});
    }
    return left;
  }

  ExprPtr parse_not_expr() {
    if (match_keyword("not")) {
      ExprPtr operand = parse_not_expr();
      return make_expr(NotExpr{std::move(operand)});
    }
    return parse_comparison_expr();
  }

  ExprPtr parse_comparison_expr() {
    ExprPtr left = parse_is_null_expr();
    const Token& token = peek();
    if (token.kind == TokenKind::Punct && is_comparison_op(token.text)) {
      std::string op = advance().text;
      ExprPtr right = parse_is_null_expr();
      return make_expr(
          BinaryExpr{std::move(left), std::move(op), std::move(right)});
    }
    return left;
  }

  ExprPtr parse_is_null_expr() {
    ExprPtr operand = parse_primary_expr();
    while (match_keyword("is")) {
      const bool negated = match_keyword("not");
      expect_keyword("null");
      operand = make_expr(IsNullExpr{std::move(operand), negated});
    }
    return operand;
  }

  ExprPtr parse_primary_expr() {
    if (match_punct("(")) {
      ExprPtr inner = parse_or_expr();
      expect_punct(")", "to close a parenthesized expression");
      return inner;
    }
    const Token& token = peek();
    if (token.kind == TokenKind::Number || token.kind == TokenKind::String ||
        (token.kind == TokenKind::Punct && token.text == "-")) {
      return make_expr(parse_literal_value());
    }
    if (token.kind == TokenKind::Identifier) {
      if (iaqs::to_lower_ascii(token.text) == "null") {
        return make_expr(parse_literal_value());
      }
      ColumnRef column;
      column.name = advance().text;
      return make_expr(std::move(column));
    }
    fail("expected an expression (literal, column name or '(')");
  }

  std::vector<Token> tokens_;
  std::size_t pos_ = 0;
};

}  // namespace

std::vector<Stmt> parse_sql(std::string_view text) {
  Parser parser(tokenize(text));
  return parser.parse_statements();
}

}  // namespace iaqs::sql
