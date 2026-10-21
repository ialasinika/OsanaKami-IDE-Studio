// Slotted heap table: a chain of Heap pages reached through PageRefs.
#pragma once

#include <cstdint>
#include <vector>

#include "core/util.h"
#include "db/page.h"
#include "db/pager.h"

namespace iaqs::db {

struct Rid {
  PageRef ref;
  uint16_t slot = 0;
};

class HeapTable {
 public:
  HeapTable(Pager& pager, PageRef root);

  // Allocates an empty heap page and returns its reference.
  static PageRef create(Pager& pager);

  // Current reference of the root page; it changes whenever the root is written.
  PageRef root() const;

  // Appends the record to the last page of the chain, allocating a new page when
  // the tail is full or the record does not fit. Throws when the record is too
  // large for a single heap page.
  Rid insert(ByteSpan record);

  // Reads the record back. Throws std::runtime_error when the slot was removed
  // or is out of range.
  Bytes get(Rid rid);

  // Marks the slot as deleted (tombstone) and returns whether it was live.
  bool remove(Rid rid);

  // Returns live rows in page-chain order (i.e. insertion order).
  std::vector<Rid> scan();

 private:
  Pager& pager_;
  PageRef root_;
};

}  // namespace iaqs::db
