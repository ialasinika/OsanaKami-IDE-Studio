// Persistent fixed-key-length B+ tree index built on the encrypted Pager.
//
// Keys are always FixedBTree::kKeySize (32) raw bytes compared with memcmp
// (unsigned byte order). Values are row ids: only the heap page address
// (seg, page) and the u16 slot are persisted; PageRef::generation is not
// stored, so Rid.ref.generation is always 0 when a value is read back.
// Consumers locate rows by (seg, page) only (HeapTable ignores the generation
// when matching a Rid's page), therefore a stale generation can never leak out
// of the index.
//
// Page layouts (every body is fixed-size -- max_plain_page_size(page_size) minus
// kPageHeaderSize bytes -- and zero filled beyond the live data):
//
//   Leaf (PageType::BTreeLeaf)
//     [u32 next_leaf_seg][u32 next_leaf_page][u16 count][u16 reserved]
//     count * [key 32B][u32 rid_seg][u32 rid_page][u16 rid_slot]   (42B each)
//     Leaves are sorted ascending and chained left-to-right; next_leaf is (0,0)
//     on the last leaf, so scan() is a single left-to-right pass.
//
//   Internal (PageType::BTreeInternal)
//     [u16 count][u16 reserved]                  // separators; child count = count+1
//     [u32 child0_seg][u32 child0_page]
//     count * [key 32B][u32 child_seg][u32 child_page]              (40B each)
//     Search rule: descend child i where i is the first index with
//     search_key < keys[i] (strict comparison), else the last child. Hence all
//     keys in the left subtree of separator keys[i] are < keys[i] and all keys
//     in the right subtree are >= keys[i].
//
// Child and next-leaf references persist (seg, page) only. Every read resolves
// the latest generation through Pager::current_ref() first, which keeps parents
// valid when a child is rewritten (each write bumps the child's generation)
// without rewriting the whole root->leaf path. remove() only deletes from the
// leaf, no merge/rebalance (design 06): separators can become stale lower
// bounds but stay valid for the strict search rule above, and pages emptied by
// removes are left in place for gc.
#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <utility>
#include <vector>

#include "core/util.h"
#include "db/heap.h"
#include "db/page.h"
#include "db/pager.h"

namespace iaqs::db {

class FixedBTree {
 public:
  static constexpr std::size_t kKeySize = 32;

  // Opens an existing tree. `root` must point at an existing leaf/internal
  // page; its generation may be stale because it is re-resolved on every
  // access. Throws std::runtime_error when the root page is missing or is not
  // a B+ tree page.
  FixedBTree(Pager& pager, PageRef root);

  // Allocates an empty leaf page and returns the new (empty) tree.
  static FixedBTree create(Pager& pager);

  // Latest reference of the root page. Persist it after mutating the tree: a
  // root split allocates a new page, so the value can change.
  PageRef root() const;

  // Looks up `key` (exactly kKeySize bytes, else std::runtime_error).
  std::optional<Rid> find(ByteSpan key) const;

  // Inserts (key, rid) or overwrites the value of an existing key.
  void insert(ByteSpan key, Rid rid);

  // Removes `key` from its leaf. Returns false when it is not present. No
  // merge/rebalance is performed (see the class comment).
  bool remove(ByteSpan key);

  // Returns all (key, rid) pairs in ascending key order.
  std::vector<std::pair<Bytes, Rid>> scan() const;

 private:
  // find/scan are const per the integration contract but the Pager read API
  // is not; a writable reference keeps those methods const-correct in shape
  // without mutable state. Single writer / single thread by design.
  Pager& page_cache() const { return const_cast<Pager&>(pager_); }

  Pager& pager_;
  PageRef root_;
};

}  // namespace iaqs::db
