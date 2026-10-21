#include "db/btree.h"

#include <algorithm>
#include <array>
#include <cstring>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace iaqs::db {
namespace {

using KeyBytes = std::array<uint8_t, FixedBTree::kKeySize>;

// ---- on-disk layout constants (see the class comment in btree.h) ----------
constexpr std::size_t kLeafHeaderSize = 12;    // u32 next_seg, u32 next_page,
                                               // u16 count, u16 reserved
constexpr std::size_t kLeafValueSize = 10;     // u32 seg, u32 page, u16 slot
constexpr std::size_t kLeafEntrySize = FixedBTree::kKeySize + kLeafValueSize;
constexpr std::size_t kInternalHeaderSize = 4; // u16 count, u16 reserved
constexpr std::size_t kChildRefSize = 8;       // u32 seg, u32 page
constexpr std::size_t kInternalEntrySize = FixedBTree::kKeySize + kChildRefSize;

// Defensive bounds for corrupt or hostile input.
constexpr std::size_t kMaxDepth = 64;
constexpr std::size_t kMaxLeafChain = std::size_t{1} << 22;

[[noreturn]] void corrupt(const char* what, const PageRef& ref) {
  throw std::runtime_error("FixedBTree: " + std::string(what) + " " +
                           page_ref_to_string(ref));
}

std::size_t page_capacity(const Pager& pager) {
  const std::size_t capacity =
      max_plain_page_size(pager.page_size()) - kPageHeaderSize;
  if (capacity < 256 || capacity > 0xFFFF) {
    throw std::runtime_error("FixedBTree: unsupported page size");
  }
  return capacity;
}

std::size_t leaf_max_entries(const Pager& pager) {
  return (page_capacity(pager) - kLeafHeaderSize) / kLeafEntrySize;
}

std::size_t internal_max_keys(const Pager& pager) {
  return (page_capacity(pager) - kInternalHeaderSize - kChildRefSize) /
         kInternalEntrySize;
}

int compare_key(ByteSpan key, const uint8_t* stored) {
  return std::memcmp(key.data(), stored, FixedBTree::kKeySize);
}

void check_key(ByteSpan key) {
  if (key.size() != FixedBTree::kKeySize) {
    throw std::runtime_error(
        "FixedBTree: key must be exactly " +
        std::to_string(static_cast<unsigned long long>(FixedBTree::kKeySize)) +
        " bytes, got " +
        std::to_string(static_cast<unsigned long long>(key.size())));
  }
}

// ---- generic node loading ------------------------------------------------
struct NodeHeader {
  PageRef ref;  // resolved (current generation)
  PageType type = PageType::Free;
  Bytes body;
};

NodeHeader load_node(Pager& pager, const PageRef& stored) {
  if (stored.seg == 0 && stored.page == 0) {
    corrupt("null page reference", stored);
  }
  NodeHeader node;
  node.ref = pager.current_ref(stored.seg, stored.page);
  const Bytes& plain = pager.read_page(node.ref);
  PageHeader header;
  ByteSpan body;
  if (!decode_page(bytes_span(plain), header, body)) {
    corrupt("corrupt page", node.ref);
  }
  node.type = header.type;
  node.body.assign(bytes_view(body));
  if (node.body.size() > 0xFFFF) corrupt("oversized page body", node.ref);
  return node;
}

// ---- leaf pages ----------------------------------------------------------
struct LeafEntry {
  KeyBytes key{};
  uint32_t seg = 0;
  uint32_t page = 0;
  uint16_t slot = 0;
};

struct LeafNode {
  PageRef ref;
  PageRef next;  // generation is never stored; (0,0) means "last leaf"
  std::vector<LeafEntry> entries;
};

LeafNode parse_leaf(const NodeHeader& node) {
  if (node.type != PageType::BTreeLeaf) {
    corrupt("page is not a leaf", node.ref);
  }
  LeafNode leaf;
  leaf.ref = node.ref;
  if (node.body.size() < kLeafHeaderSize) corrupt("short leaf body", node.ref);
  const uint8_t* p = reinterpret_cast<const uint8_t*>(node.body.data());
  leaf.next = PageRef{load_u32_le(p), load_u32_le(p + 4), 0};
  const std::size_t count = load_u16_le(p + 8);
  const std::size_t max_entries =
      (node.body.size() - kLeafHeaderSize) / kLeafEntrySize;
  if (count > max_entries) corrupt("leaf entry count out of range", node.ref);
  const bool has_next = leaf.next.seg != 0 || leaf.next.page != 0;
  if (has_next && leaf.next.page == 0) corrupt("corrupt leaf link", node.ref);
  leaf.entries.resize(count);
  const uint8_t* base = p + kLeafHeaderSize;
  for (std::size_t i = 0; i < count; ++i) {
    const uint8_t* q = base + i * kLeafEntrySize;
    std::memcpy(leaf.entries[i].key.data(), q, FixedBTree::kKeySize);
    leaf.entries[i].seg = load_u32_le(q + FixedBTree::kKeySize);
    leaf.entries[i].page = load_u32_le(q + FixedBTree::kKeySize + 4);
    leaf.entries[i].slot = load_u16_le(q + FixedBTree::kKeySize + 8);
  }
  return leaf;
}

Bytes build_leaf_body(const Pager& pager, const LeafNode& leaf) {
  const std::size_t capacity = page_capacity(pager);
  const std::size_t max_entries =
      (capacity - kLeafHeaderSize) / kLeafEntrySize;
  if (leaf.entries.size() > max_entries) {
    throw std::runtime_error("FixedBTree: leaf page overflow");
  }
  Bytes body(capacity, '\0');
  uint8_t* p = reinterpret_cast<uint8_t*>(body.data());
  store_u32_le(p, leaf.next.seg);
  store_u32_le(p + 4, leaf.next.page);
  store_u16_le(p + 8, static_cast<uint16_t>(leaf.entries.size()));
  store_u16_le(p + 10, 0);
  uint8_t* q = p + kLeafHeaderSize;
  for (const LeafEntry& entry : leaf.entries) {
    std::memcpy(q, entry.key.data(), FixedBTree::kKeySize);
    store_u32_le(q + FixedBTree::kKeySize, entry.seg);
    store_u32_le(q + FixedBTree::kKeySize + 4, entry.page);
    store_u16_le(q + FixedBTree::kKeySize + 8, entry.slot);
    q += kLeafEntrySize;
  }
  return body;
}

PageRef write_leaf(Pager& pager, const PageRef& ref, const LeafNode& leaf) {
  const Bytes body = build_leaf_body(pager, leaf);
  const PageRef current = pager.current_ref(ref.seg, ref.page);
  return pager.update_page(current, PageType::BTreeLeaf, 0, bytes_span(body));
}

PageRef alloc_leaf(Pager& pager, const LeafNode& leaf) {
  const Bytes body = build_leaf_body(pager, leaf);
  return pager.alloc_page(PageType::BTreeLeaf, 0, bytes_span(body));
}

// Index of the first entry whose key is >= `key`.
std::size_t leaf_lower_bound(const std::vector<LeafEntry>& entries,
                             ByteSpan key) {
  std::size_t lo = 0;
  std::size_t hi = entries.size();
  while (lo < hi) {
    const std::size_t mid = lo + (hi - lo) / 2;
    if (compare_key(key, entries[mid].key.data()) > 0) {
      lo = mid + 1;  // entry still sorts before the searched key
    } else {
      hi = mid;
    }
  }
  return lo;
}

Rid rid_of(const LeafEntry& entry) {
  Rid rid;
  rid.ref = PageRef{entry.seg, entry.page, 0};
  rid.slot = entry.slot;
  return rid;
}

LeafEntry entry_of(ByteSpan key, const Rid& rid) {
  LeafEntry entry;
  std::memcpy(entry.key.data(), key.data(), FixedBTree::kKeySize);
  entry.seg = rid.ref.seg;
  entry.page = rid.ref.page;
  entry.slot = rid.slot;
  return entry;
}

Bytes key_bytes(const KeyBytes& key) {
  return Bytes(reinterpret_cast<const char*>(key.data()), key.size());
}

// ---- internal pages ------------------------------------------------------
struct InternalNode {
  PageRef ref;
  std::vector<PageRef> children;  // keys.size() + 1, generation never stored
  std::vector<KeyBytes> keys;     // strictly ascending separators
};

InternalNode parse_internal(const NodeHeader& node) {
  if (node.type != PageType::BTreeInternal) {
    corrupt("page is not an internal node", node.ref);
  }
  InternalNode inner;
  inner.ref = node.ref;
  const std::size_t min_body = kInternalHeaderSize + kChildRefSize;
  if (node.body.size() < min_body) {
    corrupt("short internal body", node.ref);
  }
  const uint8_t* p = reinterpret_cast<const uint8_t*>(node.body.data());
  const std::size_t count = load_u16_le(p);
  const std::size_t max_keys =
      (node.body.size() - min_body) / kInternalEntrySize;
  if (count > max_keys) {
    corrupt("internal key count out of range", node.ref);
  }
  inner.keys.resize(count);
  inner.children.resize(count + 1);
  inner.children[0] = PageRef{load_u32_le(p + 4), load_u32_le(p + 8), 0};
  for (std::size_t i = 0; i < count; ++i) {
    const uint8_t* q = p + min_body + i * kInternalEntrySize;
    std::memcpy(inner.keys[i].data(), q, FixedBTree::kKeySize);
    inner.children[i + 1] =
        PageRef{load_u32_le(q + FixedBTree::kKeySize),
                load_u32_le(q + FixedBTree::kKeySize + 4), 0};
  }
  for (const PageRef& child : inner.children) {
    if (child.page == 0) corrupt("null child page reference", node.ref);
  }
  return inner;
}

Bytes build_internal_body(const Pager& pager, const InternalNode& inner) {
  const std::size_t capacity = page_capacity(pager);
  const std::size_t max_keys =
      (capacity - kInternalHeaderSize - kChildRefSize) / kInternalEntrySize;
  if (inner.children.size() != inner.keys.size() + 1) {
    throw std::runtime_error("FixedBTree: internal node arity mismatch");
  }
  if (inner.keys.size() > max_keys) {
    throw std::runtime_error("FixedBTree: internal page overflow");
  }
  Bytes body(capacity, '\0');
  uint8_t* p = reinterpret_cast<uint8_t*>(body.data());
  store_u16_le(p, static_cast<uint16_t>(inner.keys.size()));
  store_u16_le(p + 2, 0);
  store_u32_le(p + 4, inner.children[0].seg);
  store_u32_le(p + 8, inner.children[0].page);
  uint8_t* q = p + kInternalHeaderSize + kChildRefSize;
  for (std::size_t i = 0; i < inner.keys.size(); ++i) {
    std::memcpy(q, inner.keys[i].data(), FixedBTree::kKeySize);
    store_u32_le(q + FixedBTree::kKeySize, inner.children[i + 1].seg);
    store_u32_le(q + FixedBTree::kKeySize + 4, inner.children[i + 1].page);
    q += kInternalEntrySize;
  }
  return body;
}

PageRef write_internal(Pager& pager, const PageRef& ref,
                       const InternalNode& inner) {
  const Bytes body = build_internal_body(pager, inner);
  const PageRef current = pager.current_ref(ref.seg, ref.page);
  return pager.update_page(current, PageType::BTreeInternal, 0,
                           bytes_span(body));
}

PageRef alloc_internal(Pager& pager, const InternalNode& inner) {
  const Bytes body = build_internal_body(pager, inner);
  return pager.alloc_page(PageType::BTreeInternal, 0, bytes_span(body));
}

// First separator index i with key < keys[i]; i == keys.size() means the last
// child, so equal keys descend to the right subtree (where they live).
std::size_t child_index(const InternalNode& inner, ByteSpan key) {
  std::size_t lo = 0;
  std::size_t hi = inner.keys.size();
  while (lo < hi) {
    const std::size_t mid = lo + (hi - lo) / 2;
    if (compare_key(key, inner.keys[mid].data()) < 0) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}

// ---- structural mutation ------------------------------------------------
struct Split {
  KeyBytes key{};  // separator promoted to the parent
  PageRef right;   // new right sibling
};

std::optional<Split> insert_node(Pager& pager, PageRef& ref, ByteSpan key,
                                 Rid rid, std::size_t depth) {
  if (depth >= kMaxDepth) corrupt("tree is too deep (corrupt link)", ref);
  const NodeHeader node = load_node(pager, ref);

  if (node.type == PageType::BTreeLeaf) {
    LeafNode leaf = parse_leaf(node);
    const std::size_t capacity = leaf_max_entries(pager);
    const std::size_t pos = leaf_lower_bound(leaf.entries, key);
    if (pos < leaf.entries.size() &&
        compare_key(key, leaf.entries[pos].key.data()) == 0) {
      leaf.entries[pos].seg = rid.ref.seg;
      leaf.entries[pos].page = rid.ref.page;
      leaf.entries[pos].slot = rid.slot;
    } else {
      leaf.entries.insert(
          leaf.entries.begin() + static_cast<std::ptrdiff_t>(pos),
          entry_of(key, rid));
    }
    if (leaf.entries.size() <= capacity) {
      ref = write_leaf(pager, ref, leaf);
      return std::nullopt;
    }
    // Split: the left page keeps the first half, a fresh right page the rest.
    const std::size_t left_count = leaf.entries.size() / 2;
    LeafNode left;
    left.ref = leaf.ref;
    left.entries.assign(leaf.entries.begin(),
                        leaf.entries.begin() +
                            static_cast<std::ptrdiff_t>(left_count));
    LeafNode right;
    right.ref = PageRef{};
    right.next = leaf.next;
    right.entries.assign(
        leaf.entries.begin() + static_cast<std::ptrdiff_t>(left_count),
        leaf.entries.end());
    // Allocate the right sibling first so the left page can link to its final
    // (seg, page) address; generations are not persisted.
    const PageRef right_ref = alloc_leaf(pager, right);
    left.next = PageRef{right_ref.seg, right_ref.page, 0};
    ref = write_leaf(pager, ref, left);
    Split split;
    split.key = right.entries.front().key;
    split.right = right_ref;
    return split;
  }

  if (node.type != PageType::BTreeInternal) {
    corrupt("unexpected page type", node.ref);
  }
  InternalNode inner = parse_internal(node);
  const std::size_t pos = child_index(inner, key);
  PageRef child = inner.children[pos];
  const std::optional<Split> child_split =
      insert_node(pager, child, key, rid, depth + 1);
  // Without a split the parent is untouched: child links store (seg, page)
  // only, so a rewritten child does not invalidate them.
  if (!child_split) return std::nullopt;

  inner.keys.insert(inner.keys.begin() + static_cast<std::ptrdiff_t>(pos),
                    child_split->key);
  inner.children.insert(
      inner.children.begin() + static_cast<std::ptrdiff_t>(pos + 1),
      child_split->right);

  const std::size_t max_keys = internal_max_keys(pager);
  if (inner.keys.size() <= max_keys) {
    ref = write_internal(pager, ref, inner);
    return std::nullopt;
  }

  // Split internal: promote the middle separator to the parent.
  const std::size_t promote = inner.keys.size() / 2;
  InternalNode left;
  left.ref = inner.ref;
  left.keys.assign(inner.keys.begin(),
                   inner.keys.begin() + static_cast<std::ptrdiff_t>(promote));
  left.children.assign(
      inner.children.begin(),
      inner.children.begin() + static_cast<std::ptrdiff_t>(promote + 1));
  InternalNode right;
  right.ref = PageRef{};
  right.keys.assign(
      inner.keys.begin() + static_cast<std::ptrdiff_t>(promote + 1),
      inner.keys.end());
  right.children.assign(
      inner.children.begin() + static_cast<std::ptrdiff_t>(promote + 1),
      inner.children.end());
  const PageRef right_ref = alloc_internal(pager, right);
  ref = write_internal(pager, ref, left);
  Split split;
  split.key = inner.keys[promote];
  split.right = right_ref;
  return split;
}

// Removes `key` from the leaf it belongs to. Only the leaf is rewritten: no
// merge/rebalance and no separator maintenance are needed because removing a
// key keeps every separator a valid range bound (design 06).
bool remove_node(Pager& pager, PageRef& ref, ByteSpan key, std::size_t depth) {
  if (depth >= kMaxDepth) corrupt("tree is too deep (corrupt link)", ref);
  const NodeHeader node = load_node(pager, ref);
  if (node.type == PageType::BTreeLeaf) {
    LeafNode leaf = parse_leaf(node);
    const std::size_t pos = leaf_lower_bound(leaf.entries, key);
    if (pos >= leaf.entries.size() ||
        compare_key(key, leaf.entries[pos].key.data()) != 0) {
      return false;
    }
    leaf.entries.erase(leaf.entries.begin() +
                       static_cast<std::ptrdiff_t>(pos));
    ref = write_leaf(pager, ref, leaf);
    return true;
  }
  if (node.type != PageType::BTreeInternal) {
    corrupt("unexpected page type", node.ref);
  }
  const InternalNode inner = parse_internal(node);
  const std::size_t pos = child_index(inner, key);
  PageRef child = inner.children[pos];
  return remove_node(pager, child, key, depth + 1);
}

// Descends to the leftmost leaf page.
PageRef leftmost_leaf(Pager& pager, PageRef root) {
  PageRef current = root;
  for (std::size_t depth = 0; depth < kMaxDepth; ++depth) {
    const NodeHeader node = load_node(pager, current);
    if (node.type == PageType::BTreeLeaf) return node.ref;
    if (node.type != PageType::BTreeInternal) {
      corrupt("unexpected page type", node.ref);
    }
    const InternalNode inner = parse_internal(node);
    current = inner.children.front();
  }
  corrupt("tree is too deep (corrupt link)", root);
}

}  // namespace

FixedBTree::FixedBTree(Pager& pager, PageRef root) : pager_(pager), root_(root) {
  const NodeHeader node = load_node(pager_, root_);
  if (node.type != PageType::BTreeLeaf &&
      node.type != PageType::BTreeInternal) {
    corrupt("root page is not a B+ tree page", node.ref);
  }
  root_ = node.ref;  // store the resolved generation for root()
}

FixedBTree FixedBTree::create(Pager& pager) {
  LeafNode empty;
  return FixedBTree(pager, alloc_leaf(pager, empty));
}

PageRef FixedBTree::root() const { return root_; }

std::optional<Rid> FixedBTree::find(ByteSpan key) const {
  check_key(key);
  Pager& pager = page_cache();
  PageRef current = root_;
  for (std::size_t depth = 0; depth < kMaxDepth; ++depth) {
    const NodeHeader node = load_node(pager, current);
    if (node.type == PageType::BTreeLeaf) {
      const LeafNode leaf = parse_leaf(node);
      const std::size_t pos = leaf_lower_bound(leaf.entries, key);
      if (pos >= leaf.entries.size() ||
          compare_key(key, leaf.entries[pos].key.data()) != 0) {
        return std::nullopt;
      }
      return rid_of(leaf.entries[pos]);
    }
    if (node.type != PageType::BTreeInternal) {
      corrupt("unexpected page type", node.ref);
    }
    const InternalNode inner = parse_internal(node);
    current = inner.children[child_index(inner, key)];
  }
  corrupt("tree is too deep (corrupt link)", root_);
}

void FixedBTree::insert(ByteSpan key, Rid rid) {
  check_key(key);
  const std::optional<Split> split = insert_node(pager_, root_, key, rid, 0);
  if (!split) return;
  // The root split: root_ now names the left half, so build a new root above
  // it. The caller is responsible for persisting the new root().
  InternalNode new_root;
  new_root.keys.push_back(split->key);
  new_root.children.push_back(PageRef{root_.seg, root_.page, 0});
  new_root.children.push_back(PageRef{split->right.seg, split->right.page, 0});
  root_ = alloc_internal(pager_, new_root);
}

bool FixedBTree::remove(ByteSpan key) {
  check_key(key);
  return remove_node(pager_, root_, key, 0);
}

std::vector<std::pair<Bytes, Rid>> FixedBTree::scan() const {
  Pager& pager = page_cache();
  PageRef leaf_ref = leftmost_leaf(pager, root_);
  std::vector<std::pair<Bytes, Rid>> rows;
  for (std::size_t pages = 0; pages < kMaxLeafChain; ++pages) {
    const NodeHeader node = load_node(pager, leaf_ref);
    const LeafNode leaf = parse_leaf(node);
    rows.reserve(rows.size() + leaf.entries.size());
    for (const LeafEntry& entry : leaf.entries) {
      rows.emplace_back(key_bytes(entry.key), rid_of(entry));
    }
    if (leaf.next.seg == 0 && leaf.next.page == 0) return rows;
    leaf_ref = leaf.next;
  }
  throw std::runtime_error("FixedBTree: leaf chain is cyclic or too long");
}

}  // namespace iaqs::db
