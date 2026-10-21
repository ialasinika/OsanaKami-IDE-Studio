// iaqs SQL front end: lexer interface.
//
// The lexer is exposed so token-level behaviour (locations, string escaping,
// comments) can be tested directly; normal callers use parse_sql() from ast.h.
#pragma once

#include <string>
#include <string_view>
#include <vector>

#include "sql/ast.h"

namespace iaqs::sql {

// Keywords are NOT a separate token kind: they arrive as Identifier tokens and
// the parser compares them case-insensitively. This keeps identifiers such as
// `value` or `table` usable as names.
enum class TokenKind {
  Identifier,  // letter/_ followed by letters, digits or _
  Number,      // digits with an optional fractional part: 42, 3.14
  String,      // single-quoted, '' escapes decoded, quotes stripped
  Punct,       // one of ( ) , ; * = != <> < <= > >= -
  End,         // virtual token after the last real token
};

struct Token {
  TokenKind kind = TokenKind::End;
  std::string text;  // decoded payload (see TokenKind comments)
  int line = 1;      // 1-based line of the first character
  int col = 1;       // 1-based column of the first character
};

// Splits `text` into tokens, skipping whitespace and `--` line comments. Always
// ends with an End token. Throws std::runtime_error ("line:column: ...") for
// unknown characters, malformed operators and unterminated string literals.
std::vector<Token> tokenize(std::string_view text);

}  // namespace iaqs::sql
