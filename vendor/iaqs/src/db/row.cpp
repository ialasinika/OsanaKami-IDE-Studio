#include "db/row.h"

#include <cstring>
#include <stdexcept>
#include <utility>

namespace iaqs::db {
namespace {

// u16 total length + u8 NULL bitmap length.
constexpr size_t kRowPrefixSize = 3;
constexpr size_t kMaxRowLength = 0xFFFF;

size_t bitmap_bytes(size_t columns) { return (columns + 7) / 8; }

// Zigzag maps signed integers onto unsigned ones so small negatives stay small.
uint64_t zigzag_encode(int64_t value) {
  uint64_t bits = 0;
  std::memcpy(&bits, &value, sizeof bits);
  return (bits << 1) ^ (0ULL - (bits >> 63));
}

int64_t zigzag_decode(uint64_t value) {
  const uint64_t bits = (value >> 1) ^ (0ULL - (value & 1));
  int64_t decoded = 0;
  std::memcpy(&decoded, &bits, sizeof decoded);
  return decoded;
}

void set_bit(uint8_t* bitmap, size_t index) {
  bitmap[index / 8] = static_cast<uint8_t>(
      bitmap[index / 8] | static_cast<uint8_t>(1u << (index % 8)));
}

bool get_bit(const uint8_t* bitmap, size_t index) {
  return (bitmap[index / 8] & static_cast<uint8_t>(1u << (index % 8))) != 0;
}

const char* type_name(ValueType type) {
  switch (type) {
    case ValueType::Null:
      return "NULL";
    case ValueType::Integer:
      return "INTEGER";
    case ValueType::Real:
      return "REAL";
    case ValueType::Text:
      return "TEXT";
    case ValueType::Blob:
      return "BLOB";
  }
  return "?";
}

std::string column_label(const ColumnDef& column, size_t index) {
  return "column " + std::to_string(index) + " (" + column.name + ")";
}

}  // namespace

Value Value::null() { return Value{}; }

Value Value::integer(int64_t v) {
  Value value;
  value.type = ValueType::Integer;
  value.int_value = v;
  return value;
}

Value Value::real(double v) {
  Value value;
  value.type = ValueType::Real;
  value.real_value = v;
  return value;
}

Value Value::text(Bytes v) {
  Value value;
  value.type = ValueType::Text;
  value.bytes = std::move(v);
  return value;
}

Value Value::blob(Bytes v) {
  Value value;
  value.type = ValueType::Blob;
  value.bytes = std::move(v);
  return value;
}

Bytes encode_row(const TableSchema& schema, const Row& row) {
  const size_t columns = schema.columns.size();
  if (row.values.size() != columns) {
    throw std::runtime_error(
        "encode_row: expected " + std::to_string(columns) + " values, got " +
        std::to_string(row.values.size()));
  }
  const size_t bitmap_len = bitmap_bytes(columns);
  if (bitmap_len > 0xFF) {
    throw std::runtime_error("encode_row: too many columns for the NULL bitmap");
  }

  Bytes null_bitmap(bitmap_len, '\0');
  uint8_t* bitmap = reinterpret_cast<uint8_t*>(null_bitmap.data());
  Bytes values;
  for (size_t i = 0; i < columns; ++i) {
    const Value& value = row.values[i];
    const ColumnDef& column = schema.columns[i];
    if (value.type == ValueType::Null) {
      set_bit(bitmap, i);
      continue;
    }
    if (value.type != column.type) {
      throw std::runtime_error("encode_row: " + column_label(column, i) +
                               " expects " + type_name(column.type) +
                               ", got " + type_name(value.type));
    }
    switch (column.type) {
      case ValueType::Integer:
        append_uvarint(values, zigzag_encode(value.int_value));
        break;
      case ValueType::Real: {
        uint64_t bits = 0;
        std::memcpy(&bits, &value.real_value, sizeof bits);
        append_u64_le(values, bits);
        break;
      }
      case ValueType::Text:
      case ValueType::Blob:
        append_uvarint(values, value.bytes.size());
        values.append(value.bytes);
        break;
      case ValueType::Null:
        // Guarded above: a NULL-typed column only accepts a NULL value.
        throw std::runtime_error("encode_row: " + column_label(column, i) +
                                 " has type NULL");
    }
  }

  const size_t total = kRowPrefixSize + null_bitmap.size() + values.size();
  if (total > kMaxRowLength) {
    throw std::runtime_error("encode_row: encoded row does not fit in u16");
  }
  Bytes out;
  out.reserve(total);
  append_u16_le(out, static_cast<uint16_t>(total));
  out.push_back(static_cast<char>(static_cast<uint8_t>(bitmap_len)));
  out.append(null_bitmap);
  out.append(values);
  return out;
}

Row decode_row(const TableSchema& schema, ByteSpan data) {
  const size_t columns = schema.columns.size();
  if (data.size() < kRowPrefixSize) {
    throw std::runtime_error("decode_row: truncated row prefix");
  }
  const uint16_t total = load_u16_le(data.data());
  if (static_cast<size_t>(total) != data.size()) {
    throw std::runtime_error("decode_row: length prefix does not match input");
  }

  ByteSpan rest = data.subspan(2);
  const size_t bitmap_len = rest[0];
  rest = rest.subspan(1);
  if (bitmap_len != bitmap_bytes(columns)) {
    throw std::runtime_error("decode_row: NULL bitmap length mismatch");
  }
  if (rest.size() < bitmap_len) {
    throw std::runtime_error("decode_row: truncated NULL bitmap");
  }
  const uint8_t* bitmap = rest.data();
  rest = rest.subspan(bitmap_len);

  Row row;
  row.values.resize(columns);
  for (size_t i = 0; i < columns; ++i) {
    if (get_bit(bitmap, i)) {
      row.values[i] = Value::null();
      continue;
    }
    const ValueType type = schema.columns[i].type;
    switch (type) {
      case ValueType::Integer: {
        uint64_t raw = 0;
        if (!read_uvarint(rest, raw)) {
          throw std::runtime_error("decode_row: truncated INTEGER");
        }
        row.values[i] = Value::integer(zigzag_decode(raw));
        break;
      }
      case ValueType::Real: {
        if (rest.size() < 8) {
          throw std::runtime_error("decode_row: truncated REAL");
        }
        const uint64_t bits = load_u64_le(rest.data());
        double real = 0.0;
        std::memcpy(&real, &bits, sizeof real);
        rest = rest.subspan(8);
        row.values[i] = Value::real(real);
        break;
      }
      case ValueType::Text:
      case ValueType::Blob: {
        uint64_t raw_len = 0;
        if (!read_uvarint(rest, raw_len)) {
          throw std::runtime_error("decode_row: truncated length prefix");
        }
        if (raw_len > rest.size()) {
          throw std::runtime_error("decode_row: value length exceeds row data");
        }
        const size_t len = static_cast<size_t>(raw_len);
        Bytes bytes;
        if (len != 0) bytes.assign(reinterpret_cast<const char*>(rest.data()), len);
        rest = rest.subspan(len);
        row.values[i] = (type == ValueType::Text) ? Value::text(std::move(bytes))
                                                  : Value::blob(std::move(bytes));
        break;
      }
      case ValueType::Null:
        throw std::runtime_error("decode_row: non-NULL value in a NULL column");
    }
  }
  if (!rest.empty()) {
    throw std::runtime_error("decode_row: trailing bytes after last column");
  }
  return row;
}

}  // namespace iaqs::db
