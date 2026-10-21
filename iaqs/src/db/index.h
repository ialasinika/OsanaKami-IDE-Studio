// Secondary (non-unique) indexes for the relational engine (M2).
//
// A secondary index is a FixedBTree::kKeySize (32)-byte-key B+ tree whose value
// is a row id. Keys combine the indexed column value with the row id so every
// duplicate column value gets its own entry (the index is non-unique):
//
//   byte offset   0 .. 21      22      26      30      32
//   key layout    [value prefix][seg u32][page u32][slot u16]
//   size          22            4        4         2
//
// The rid suffix is part of the key, so an equality probe is a *prefix range*
// of the tree (all entries sharing the value prefix) rather than a single
// FixedBTree::find() lookup -- that is what makes duplicate rows work.
//
// The value prefix is order-preserving for the supported column types and is
// written in big-endian byte order so memcmp() (FixedBTree's key order) is
// lexicographic numeric/byte order:
//
//   INTEGER : (uint64_t)v XOR 0x8000000000000000, big-endian. Flips the sign
//             bit so negative numbers sort before positive ones.
//   REAL    : IEEE-754 bits; sign bit set -> ~bits, else bits | 0x8000...
//             (total order). Both zeros are normalized to the +0.0 encoding
//             because SQL compares -0.0 == +0.0, so a zero row is never missed
//             by an equality or range probe.
//   TEXT    : raw bytes, truncated to the 22-byte prefix, zero padded.
//   BLOB    : same as TEXT (raw bytes).
//
// TEXT/BLOB values longer than 22 bytes are indexed by their first 22 bytes
// only. An index probe is therefore a *prefix filter*: it can return more rows
// than satisfy the predicate, never fewer. Callers must evaluate the full WHERE
// predicate on every candidate row, which keeps results exact while range
// selectivity degrades for values that share a long prefix.
//
// NULL is never put into an index: SQL's three-valued logic means NULL never
// satisfies a comparison predicate, so a NULL row can never be a candidate.
//
// Probes materialise the tree's ordered (key, rid) list with FixedBTree::scan()
// and binary-search the prefix range: the B+ tree has no range iterator in its
// public API. The probe is therefore O(number of index entries) cache reads but
// never touches the heap rows that do not match, which is the observable
// "query uses the index" contract of this module.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

#include "core/util.h"
#include "db/btree.h"
#include "db/heap.h"
#include "db/page.h"
#include "db/row.h"

namespace iaqs::db {

// Catalog entry of one secondary index: name, owning table, indexed column, the
// column value type (needed to encode probe bounds) and the B+ tree root page.
// Index names are case-insensitive and stored normalized (lower-case); `table`
// is normalized the same way as TableInfo::schema::name; `column` keeps the
// schema spelling.
struct IndexInfo {
  std::string name;
  std::string table;
  std::string column;
  ValueType type = ValueType::Null;
  uint32_t root_seg = 0;
  uint32_t root_page = 0;

  PageRef root_ref() const { return PageRef{root_seg, root_page, 0}; }
};

// One key = 22-byte value prefix + 10-byte rid suffix (FixedBTree::kKeySize).
inline constexpr std::size_t kIndexRidSuffixSize = 10;
inline constexpr std::size_t kIndexValuePrefixSize =
    FixedBTree::kKeySize - kIndexRidSuffixSize;  // 22

using IndexKey = std::array<uint8_t, FixedBTree::kKeySize>;

// Encodes `value` into the 22-byte prefix (bytes 0..21 of `out`, the rest is
// untouched). Throws std::runtime_error for ValueType::Null. The caller is
// responsible for passing a value of the indexed column's type.
void encode_index_value_prefix(const Value& value, uint8_t* out);

// Full key: value prefix followed by the big-endian (seg, page, slot) rid.
IndexKey encode_index_key(const Value& value, const Rid& rid);

// Rid stored in a key's 10-byte suffix (generation is not persisted; it is
// reported as 0 exactly like FixedBTree values).
Rid index_key_rid(const uint8_t* key);

// Comparison operators supported by an index probe. Range predicates
// (<, <=, >, >=) yield a prefix range; equality yields the equal-prefix range.
enum class IndexOp { Equal, Less, LessEq, Greater, GreaterEq };

// Returns every row id whose indexed-value *prefix* satisfies `op` against the
// prefix of `value`. For Less/LessEq the result is a superset of "value <
// literal"; for Greater/GreaterEq a superset of "value > literal"; for Equal a
// superset of "value = literal" (truncation can add false positives for long
// TEXT/BLOB values). Callers recheck the full predicate on the fetched rows.
std::vector<Rid> probe_index(const FixedBTree& tree, const Value& value,
                             IndexOp op);

}  // namespace iaqs::db
