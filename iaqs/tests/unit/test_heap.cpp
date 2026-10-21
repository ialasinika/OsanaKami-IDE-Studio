#include "db/heap.h"

#include <filesystem>
#include <limits>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

#include "core/util.h"
#include "crypto/rand.h"
#include "db/page.h"
#include "db/pager.h"
#include "db/row.h"
#include "harness.h"

using namespace iaqs;
using namespace iaqs::db;

namespace {

std::string make_tmp_dir() {
  const std::string name = "iaqs-heap-" + to_hex(bytes_span(random_bytes(8)));
  const std::string dir =
      (std::filesystem::temp_directory_path() / name).string();
  make_dirs(dir);
  return dir;
}

void remove_tmp_dir(const std::string& dir) {
  std::error_code ec;
  std::filesystem::remove_all(std::filesystem::path(dir), ec);
}

struct TmpHeapDir {
  std::string dir = make_tmp_dir();
  ~TmpHeapDir() { remove_tmp_dir(dir); }
};
TableSchema all_types_schema() {
  TableSchema schema;
  schema.name = "items";
  schema.columns = {
      ColumnDef{"id", ValueType::Integer, /*primary_key=*/true, /*not_null=*/true},
      ColumnDef{"score", ValueType::Real, false, false},
      ColumnDef{"title", ValueType::Text, false, false},
      ColumnDef{"payload", ValueType::Blob, false, false},
  };
  return schema;
}

TableSchema integer_schema() {
  TableSchema schema;
  schema.name = "numbers";
  schema.columns = {ColumnDef{"n", ValueType::Integer, false, false}};
  return schema;
}

bool same_page(const PageRef& a, const PageRef& b) {
  return a.seg == b.seg && a.page == b.page;
}

ByteSpan as_span(const Bytes& bytes) { return bytes_span(std::string_view(bytes)); }

}  // namespace

IAQS_TEST(row, roundtrip_all_types) {
  const TableSchema schema = all_types_schema();
  Row row;
  row.values = {Value::integer(-123456789), Value::real(3.5),
                Value::text(Bytes("hello")),
                Value::blob(Bytes("\x00\x01\xFF", 3))};
  const Bytes encoded = encode_row(schema, row);
  CHECK(encoded.size() > 3);
  CHECK_EQ(encoded.size(),
           static_cast<size_t>(load_u16_le(reinterpret_cast<const uint8_t*>(
               encoded.data()))));
  const Row decoded = decode_row(schema, as_span(encoded));
  CHECK_EQ(decoded.values.size(), size_t{4});
  CHECK_EQ(decoded.values[0].type, ValueType::Integer);
  CHECK_EQ(decoded.values[0].int_value, int64_t{-123456789});
  CHECK_EQ(decoded.values[1].type, ValueType::Real);
  CHECK_EQ(decoded.values[1].real_value, 3.5);
  CHECK_EQ(decoded.values[2].type, ValueType::Text);
  CHECK_EQ(decoded.values[2].bytes, Bytes("hello"));
  CHECK_EQ(decoded.values[3].type, ValueType::Blob);
  CHECK_EQ(decoded.values[3].bytes, Bytes("\x00\x01\xFF", 3));
}

IAQS_TEST(row, roundtrip_all_null) {
  const TableSchema schema = all_types_schema();
  Row row;
  row.values = {Value::null(), Value::null(), Value::null(), Value::null()};
  const Row decoded = decode_row(schema, as_span(encode_row(schema, row)));
  CHECK_EQ(decoded.values.size(), size_t{4});
  for (const Value& value : decoded.values) {
    CHECK_EQ(value.type, ValueType::Null);
  }
}

IAQS_TEST(row, null_mixed_with_values) {
  const TableSchema schema = all_types_schema();
  Row row;
  row.values = {Value::integer(7), Value::null(), Value::null(),
                Value::blob(Bytes("b"))};
  const Row decoded = decode_row(schema, as_span(encode_row(schema, row)));
  CHECK_EQ(decoded.values[0].int_value, int64_t{7});
  CHECK_EQ(decoded.values[1].type, ValueType::Null);
  CHECK_EQ(decoded.values[2].type, ValueType::Null);
  CHECK_EQ(decoded.values[3].type, ValueType::Blob);
  CHECK_EQ(decoded.values[3].bytes, Bytes("b"));
}

IAQS_TEST(row, zigzag_int64_extremes) {
  const TableSchema schema = integer_schema();
  const int64_t values[] = {std::numeric_limits<int64_t>::min(),
                            std::numeric_limits<int64_t>::max(), -1, 0, 1, -2,
                            42, -1000000000000LL};
  for (const int64_t wanted : values) {
    Row row;
    row.values = {Value::integer(wanted)};
    const Row decoded = decode_row(schema, as_span(encode_row(schema, row)));
    CHECK_EQ(decoded.values[0].int_value, wanted);
  }
}

IAQS_TEST(row, encode_rejects_bad_rows) {
  const TableSchema schema = integer_schema();

  Row wrong_count;
  wrong_count.values = {Value::integer(1), Value::integer(2)};
  CHECK_THROW(encode_row(schema, wrong_count), std::runtime_error);

  Row empty_row;
  CHECK_THROW(encode_row(schema, empty_row), std::runtime_error);

  Row wrong_type;
  wrong_type.values = {Value::text(Bytes("x"))};
  CHECK_THROW(encode_row(schema, wrong_type), std::runtime_error);

  // A row whose u16 length prefix would overflow.
  TableSchema blob_schema;
  blob_schema.columns = {ColumnDef{"b", ValueType::Blob, false, false}};
  Row huge;
  huge.values = {Value::blob(Bytes(0xFFFF, 'x'))};
  CHECK_THROW(encode_row(blob_schema, huge), std::runtime_error);
}

IAQS_TEST(row, decode_rejects_corrupt_input) {
  const TableSchema schema = integer_schema();
  Row row;
  row.values = {Value::integer(5)};
  const Bytes encoded = encode_row(schema, row);

  Bytes truncated = encoded;
  truncated.pop_back();
  CHECK_THROW(decode_row(schema, as_span(truncated)), std::runtime_error);

  Bytes trailing = encoded;
  trailing.push_back('\0');
  CHECK_THROW(decode_row(schema, as_span(trailing)), std::runtime_error);

  Bytes bad_bitmap = encoded;
  bad_bitmap[2] = '\0';
  CHECK_THROW(decode_row(schema, as_span(bad_bitmap)), std::runtime_error);

  CHECK_THROW(decode_row(schema, ByteSpan{}), std::runtime_error);
}

IAQS_TEST(heap, insert_scan_and_get_single_page) {
  TmpHeapDir tmp;
  Pager pager(tmp.dir, 4096, 4096ull * 8);
  HeapTable table(pager, HeapTable::create(pager));

  const char* records[] = {"alpha", "beta", "gamma"};
  std::vector<Rid> rids;
  for (const char* record : records) {
    rids.push_back(table.insert(bytes_span(std::string_view(record))));
  }
  const std::vector<Rid> scanned = table.scan();
  CHECK_EQ(scanned.size(), size_t{3});
  for (size_t i = 0; i < scanned.size(); ++i) {
    CHECK_EQ(scanned[i].slot, rids[i].slot);
    CHECK_EQ(table.get(scanned[i]), Bytes(records[i]));
    CHECK_EQ(table.get(rids[i]), Bytes(records[i]));
    CHECK(same_page(scanned[i].ref, table.root()));
  }
}

IAQS_TEST(heap, remove_is_tombstone_and_second_remove_is_false) {
  TmpHeapDir tmp;
  Pager pager(tmp.dir, 4096, 4096ull * 8);
  HeapTable table(pager, HeapTable::create(pager));

  std::vector<Rid> rids;
  for (int i = 0; i < 5; ++i) {
    const std::string record = "row" + std::to_string(i);
    rids.push_back(table.insert(bytes_span(std::string_view(record))));
  }
  CHECK(table.remove(rids[2]));
  CHECK_THROW(table.get(rids[2]), std::runtime_error);
  CHECK(!table.remove(rids[2]));

  const std::vector<Rid> scanned = table.scan();
  CHECK_EQ(scanned.size(), size_t{4});
  for (const Rid& rid : scanned) {
    CHECK(!(same_page(rid.ref, rids[2].ref) && rid.slot == rids[2].slot));
  }
  CHECK_EQ(table.get(rids[0]), Bytes("row0"));
  CHECK_EQ(table.get(rids[4]), Bytes("row4"));
}

IAQS_TEST(heap, many_rows_span_pages_in_insertion_order) {
  TmpHeapDir tmp;
  Pager pager(tmp.dir, 1024, 1024ull * 128);
  HeapTable table(pager, HeapTable::create(pager));

  std::set<uint32_t> pages;
  std::vector<std::string> expected;
  for (int i = 0; i < 200; ++i) {
    const std::string record = "row-" + std::to_string(i) + std::string(20, 'x');
    expected.push_back(record);
    const Rid rid = table.insert(bytes_span(std::string_view(record)));
    pages.insert(rid.ref.page);
  }
  CHECK(pages.size() > 1);

  const std::vector<Rid> scanned = table.scan();
  CHECK_EQ(scanned.size(), expected.size());
  for (size_t i = 0; i < scanned.size(); ++i) {
    CHECK_EQ(table.get(scanned[i]), Bytes(expected[i]));
  }
}

IAQS_TEST(heap, reopen_pager_keeps_rows_readable) {
  TmpHeapDir tmp;
  const std::vector<std::string> expected = {"first", "second", "third"};
  PageRef root;
  {
    Pager pager(tmp.dir, 4096, 4096ull * 8);
    HeapTable table(pager, HeapTable::create(pager));
    for (const std::string& record : expected) {
      table.insert(bytes_span(std::string_view(record)));
    }
    root = table.root();
    pager.flush();
  }
  Pager reopened(tmp.dir, 4096, 4096ull * 8);
  HeapTable table(reopened, root);
  const std::vector<Rid> scanned = table.scan();
  CHECK_EQ(scanned.size(), expected.size());
  for (size_t i = 0; i < scanned.size(); ++i) {
    CHECK_EQ(table.get(scanned[i]), Bytes(expected[i]));
  }
}

IAQS_TEST(heap, get_rejects_out_of_range_slot) {
  TmpHeapDir tmp;
  Pager pager(tmp.dir, 4096, 4096ull * 8);
  HeapTable table(pager, HeapTable::create(pager));
  const Rid rid = table.insert(bytes_span(std::string_view("only")));
  Rid out_of_range;
  out_of_range.ref = rid.ref;
  out_of_range.slot = static_cast<uint16_t>(rid.slot + 7);
  CHECK_THROW(table.get(out_of_range), std::runtime_error);
}

IAQS_TEST(heap, empty_record_roundtrips_and_is_removable) {
  TmpHeapDir tmp;
  Pager pager(tmp.dir, 4096, 4096ull * 8);
  HeapTable table(pager, HeapTable::create(pager));
  const Rid empty = table.insert(ByteSpan{});
  CHECK_EQ(table.get(empty).size(), size_t{0});
  CHECK_EQ(table.scan().size(), size_t{1});
  CHECK(table.remove(empty));
  CHECK_THROW(table.get(empty), std::runtime_error);
  CHECK(table.scan().empty());
}

IAQS_TEST(heap, long_record_gets_its_own_page) {
  TmpHeapDir tmp;
  Pager pager(tmp.dir, 1024, 1024ull * 128);
  HeapTable table(pager, HeapTable::create(pager));

  for (int i = 0; i < 40; ++i) {
    const std::string record = "small-" + std::to_string(i) + std::string(28, 's');
    table.insert(bytes_span(std::string_view(record)));
  }
  const Rid previous = table.scan().back();
  const std::string long_record(900, 'L');
  const Rid long_rid = table.insert(bytes_span(std::string_view(long_record)));
  CHECK(!same_page(previous.ref, long_rid.ref));
  CHECK_EQ(table.get(long_rid), Bytes(long_record));

  // The long record's page still accepts a following small record.
  const Rid after = table.insert(bytes_span(std::string_view("tail")));
  CHECK_EQ(table.get(after), Bytes("tail"));
  CHECK(same_page(after.ref, long_rid.ref));
  CHECK_EQ(table.scan().size(), size_t{42});

  // One byte past the page capacity is rejected.
  const std::string too_large(max_plain_page_size(1024), 'X');
  CHECK_THROW(table.insert(bytes_span(std::string_view(too_large))),
              std::runtime_error);
}
