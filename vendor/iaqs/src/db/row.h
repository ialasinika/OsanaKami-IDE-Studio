// Row encoding for the internal relational engine (design 06 §4).
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "core/util.h"

namespace iaqs::db {

enum class ValueType : uint8_t { Null = 0, Integer = 1, Real = 2, Text = 3, Blob = 4 };

struct Value {
  ValueType type = ValueType::Null;
  int64_t int_value = 0;
  double real_value = 0.0;
  Bytes bytes;  // Text/Blob

  static Value null();
  static Value integer(int64_t v);
  static Value real(double v);
  static Value text(Bytes v);
  static Value blob(Bytes v);
};

struct ColumnDef {
  std::string name;
  ValueType type = ValueType::Text;
  bool primary_key = false;
  bool not_null = false;
};

struct TableSchema {
  std::string name;
  std::vector<ColumnDef> columns;
};

struct Row {
  std::vector<Value> values;
};

// Encodes one row as
//   [u16 total length incl. itself][u8 NULL bitmap len][NULL bitmap][values]
// where a non-NULL value is a zigzag varint (INTEGER), 8-byte little-endian
// IEEE754 (REAL) or a uvarint length followed by raw bytes (TEXT/BLOB).
// Throws std::runtime_error on a column count/type mismatch or when the
// encoded row does not fit the u16 length field.
Bytes encode_row(const TableSchema& schema, const Row& row);

// Decodes exactly one encoded row. Throws std::runtime_error on truncation,
// inconsistent length/bitmap fields, or trailing bytes after the last column.
Row decode_row(const TableSchema& schema, ByteSpan data);

}  // namespace iaqs::db
