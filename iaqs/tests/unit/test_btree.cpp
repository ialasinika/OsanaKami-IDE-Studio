#include "db/btree.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <map>
#include <optional>
#include <random>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "core/util.h"
#include "crypto/rand.h"
#include "db/page.h"
#include "db/pager.h"
#include "harness.h"

using namespace iaqs;
using namespace iaqs::db;

namespace {

std::string make_tmp_dir() {
  const std::string name = "iaqs-btree-" + to_hex(bytes_span(random_bytes(8)));
  const std::string dir =
      (std::filesystem::temp_directory_path() / name).string();
  make_dirs(dir);
  return dir;
}

void remove_tmp_dir(const std::string& dir) {
  std::error_code ec;
  std::filesystem::remove_all(std::filesystem::path(dir), ec);
}

struct TmpBTreeDir {
  std::string dir = make_tmp_dir();
  ~TmpBTreeDir() { remove_tmp_dir(dir); }
};
ByteSpan span(const std::string& bytes) {
  return ByteSpan(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size());
}

struct KeyLess {
  bool operator()(const std::string& a, const std::string& b) const {
    return std::memcmp(a.data(), b.data(), FixedBTree::kKeySize) < 0;
  }
};

// Deterministic pseudo-random 32-byte keys, insertion order shuffled.
std::vector<std::string> random_keys(std::size_t count, uint32_t seed) {
  std::mt19937 rng(seed);
  std::set<std::string> seen;
  std::vector<std::string> keys;
  keys.reserve(count);
  while (keys.size() < count) {
    std::string key(FixedBTree::kKeySize, '\0');
    for (char& c : key) c = static_cast<char>(rng() & 0xFFu);
    if (seen.insert(key).second) keys.push_back(key);
  }
  return keys;
}

Rid rid_for(std::uint32_t index) {
  Rid rid;
  rid.ref = PageRef{index % 7u, index + 1u, 0};
  rid.slot = static_cast<uint16_t>(index % 65536u);
  return rid;
}

bool same_rid(const Rid& a, const Rid& b) {
  return a.ref.seg == b.ref.seg && a.ref.page == b.ref.page &&
         a.slot == b.slot;
}

void expect_find(const FixedBTree& tree,
                 const std::map<std::string, Rid, KeyLess>& expected) {
  for (const auto& [key, rid] : expected) {
    const std::optional<Rid> found = tree.find(span(key));
    CHECK(found.has_value());
    if (found) CHECK(same_rid(*found, rid));
  }
}

void expect_absent(const FixedBTree& tree, const std::string& key) {
  CHECK(!tree.find(span(key)).has_value());
}

void expect_scan(const FixedBTree& tree,
                 const std::map<std::string, Rid, KeyLess>& expected) {
  const std::vector<std::pair<Bytes, Rid>> rows = tree.scan();
  CHECK_EQ(rows.size(), expected.size());
  auto it = expected.begin();
  for (const auto& row : rows) {
    CHECK(it != expected.end());
    if (it == expected.end()) break;
    CHECK_EQ(row.first, it->first);
    CHECK(same_rid(row.second, it->second));
    ++it;
  }
  CHECK(it == expected.end());
}

PageType page_type(Pager& pager, const PageRef& ref) {
  const PageRef current = pager.current_ref(ref.seg, ref.page);
  const Bytes& plain = pager.read_page(current);
  PageHeader header;
  ByteSpan body;
  if (!decode_page(bytes_span(plain), header, body)) {
    throw std::runtime_error("test: corrupt page");
  }
  return header.type;
}

// Height in pages; the tree starts at the root and always descends child 0.
std::size_t tree_height(Pager& pager, const PageRef& root) {
  PageRef current = root;
  for (std::size_t height = 1; height <= 64; ++height) {
    current = pager.current_ref(current.seg, current.page);
    const Bytes& plain = pager.read_page(current);
    PageHeader header;
    ByteSpan body;
    if (!decode_page(bytes_span(plain), header, body)) {
      throw std::runtime_error("test: corrupt page");
    }
    if (header.type == PageType::BTreeLeaf) return height;
    if (header.type != PageType::BTreeInternal) {
      throw std::runtime_error("test: unexpected page type");
    }
    if (body.size() < 12) throw std::runtime_error("test: short internal page");
    current =
        PageRef{load_u32_le(body.data() + 4), load_u32_le(body.data() + 8), 0};
  }
  throw std::runtime_error("test: tree too deep");
}

}  // namespace

IAQS_TEST(btree, empty_tree_find_scan_remove_and_persist) {
  TmpBTreeDir tmp;
  const std::string probe(FixedBTree::kKeySize, '\x01');
  PageRef root;
  {
    Pager pager(tmp.dir, 8192, 8192ull * 64);
    FixedBTree tree = FixedBTree::create(pager);
    CHECK_EQ(page_type(pager, tree.root()), PageType::BTreeLeaf);
    CHECK(tree.root().page != 0u);
    CHECK(!tree.find(span(probe)).has_value());
    CHECK(tree.scan().empty());
    CHECK(!tree.remove(span(probe)));
    root = tree.root();
    pager.sync();
  }
  Pager reopened(tmp.dir, 8192, 8192ull * 64);
  FixedBTree tree(reopened, root);
  CHECK(!tree.find(span(probe)).has_value());
  CHECK(tree.scan().empty());
  // An empty tree still accepts inserts after a reopen.
  const std::string only_key(FixedBTree::kKeySize, '\x02');
  tree.insert(span(only_key), rid_for(1));
  CHECK(tree.find(span(only_key)).has_value());
  CHECK_EQ(tree.scan().size(), std::size_t{1});
}

IAQS_TEST(btree, insert_find_scan_2000_random_keys) {
  TmpBTreeDir tmp;
  Pager pager(tmp.dir, 8192, 8192ull * 64);
  FixedBTree tree = FixedBTree::create(pager);
  const std::vector<std::string> keys = random_keys(2000, 42);
  std::map<std::string, Rid, KeyLess> expected;
  for (std::size_t i = 0; i < keys.size(); ++i) {
    const Rid rid = rid_for(static_cast<std::uint32_t>(i));
    expected.emplace(keys[i], rid);
    tree.insert(span(keys[i]), rid);
  }
  CHECK_EQ(page_type(pager, tree.root()), PageType::BTreeInternal);
  expect_find(tree, expected);
  expect_scan(tree, expected);
  // Keys that were never inserted are reported absent.
  for (const std::string& key : random_keys(64, 4242)) {
    if (expected.find(key) != expected.end()) continue;
    expect_absent(tree, key);
  }
}

IAQS_TEST(btree, overwrite_same_key_replaces_rid) {
  TmpBTreeDir tmp;
  Pager pager(tmp.dir, 8192, 8192ull * 64);
  FixedBTree tree = FixedBTree::create(pager);

  const std::string key(FixedBTree::kKeySize, '\x33');
  tree.insert(span(key), rid_for(1));
  tree.insert(span(key), rid_for(2));
  CHECK_EQ(tree.scan().size(), std::size_t{1});
  const std::optional<Rid> found = tree.find(span(key));
  CHECK(found.has_value());
  if (found) CHECK(same_rid(*found, rid_for(2)));

  // Overwrite keys on both sides of many splits.
  const std::vector<std::string> keys = random_keys(800, 7);
  std::map<std::string, Rid, KeyLess> expected;
  expected.emplace(key, rid_for(2));  // value from the overwrite above
  for (std::size_t i = 0; i < keys.size(); ++i) {
    const Rid rid = rid_for(static_cast<std::uint32_t>(i + 10));
    expected.emplace(keys[i], rid);
    tree.insert(span(keys[i]), rid);
  }
  for (std::size_t i = 0; i < keys.size(); i += 3) {
    const Rid replacement = rid_for(static_cast<std::uint32_t>(100000 + i));
    expected[keys[i]] = replacement;
    tree.insert(span(keys[i]), replacement);
  }
  CHECK_EQ(tree.scan().size(), expected.size());
  expect_find(tree, expected);
  expect_scan(tree, expected);
}

IAQS_TEST(btree, remove_half_then_all_then_reinsert) {
  TmpBTreeDir tmp;
  Pager pager(tmp.dir, 8192, 8192ull * 64);
  FixedBTree tree = FixedBTree::create(pager);
  const std::vector<std::string> keys = random_keys(2000, 99);
  std::map<std::string, Rid, KeyLess> present;
  for (std::size_t i = 0; i < keys.size(); ++i) {
    const Rid rid = rid_for(static_cast<std::uint32_t>(i));
    present.emplace(keys[i], rid);
    tree.insert(span(keys[i]), rid);
  }

  // Remove every even-indexed key: half the tree disappears.
  for (std::size_t i = 0; i < keys.size(); i += 2) {
    CHECK(tree.remove(span(keys[i])));
    CHECK(!tree.remove(span(keys[i])));  // second remove returns false
    present.erase(keys[i]);
  }
  for (std::size_t i = 0; i < keys.size(); i += 2) {
    expect_absent(tree, keys[i]);
  }
  expect_find(tree, present);
  expect_scan(tree, present);

  // Remove the rest: leaves become empty but the tree stays usable.
  for (std::size_t i = 1; i < keys.size(); i += 2) {
    CHECK(tree.remove(span(keys[i])));
  }
  CHECK(tree.scan().empty());
  for (const std::string& key : keys) {
    expect_absent(tree, key);
  }

  // Reinsert into the now-empty tree (with stale separators left in place).
  std::map<std::string, Rid, KeyLess> again;
  for (std::size_t i = 0; i < 150; ++i) {
    const Rid rid = rid_for(static_cast<std::uint32_t>(500000 + i));
    again.emplace(keys[i], rid);
    tree.insert(span(keys[i]), rid);
  }
  expect_find(tree, again);
  expect_scan(tree, again);
}

IAQS_TEST(btree, ascending_then_descending_keys) {
  TmpBTreeDir tmp;
  Pager pager(tmp.dir, 1024, 1024ull * 512);
  FixedBTree tree = FixedBTree::create(pager);
  std::map<std::string, Rid, KeyLess> expected;

  auto sequential_key = [](std::uint32_t n) {
    std::string key(FixedBTree::kKeySize, '\0');
    for (int b = 0; b < 4; ++b) {
      key[static_cast<std::size_t>(b)] =
          static_cast<char>((n >> (24 - 8 * b)) & 0xFFu);
    }
    return key;
  };
  for (std::uint32_t i = 0; i < 1000; ++i) {
    const Rid rid = rid_for(i);
    expected.emplace(sequential_key(i), rid);
    tree.insert(span(sequential_key(i)), rid);
  }
  for (std::uint32_t i = 1000; i < 2000; ++i) {
    const Rid rid = rid_for(i);
    expected.emplace(sequential_key(i), rid);
    tree.insert(span(sequential_key(i)), rid);
  }
  CHECK_EQ(tree.scan().size(), expected.size());
  expect_find(tree, expected);
  expect_scan(tree, expected);
}

IAQS_TEST(btree, insert_5000_keys_reports_height_and_timing) {
  TmpBTreeDir tmp;
  Pager pager(tmp.dir, 1024, 1024ull * 512);
  FixedBTree tree = FixedBTree::create(pager);
  const std::vector<std::string> keys = random_keys(5000, 7);
  std::map<std::string, Rid, KeyLess> expected;
  using Clock = std::chrono::steady_clock;

  const auto insert_start = Clock::now();
  for (std::size_t i = 0; i < keys.size(); ++i) {
    const Rid rid = rid_for(static_cast<std::uint32_t>(i));
    expected.emplace(keys[i], rid);
    tree.insert(span(keys[i]), rid);
  }
  const auto insert_end = Clock::now();

  const auto find_start = Clock::now();
  std::size_t misses = 0;
  for (const std::string& key : keys) {
    if (!tree.find(span(key)).has_value()) ++misses;
  }
  const auto find_end = Clock::now();

  CHECK_EQ(misses, std::size_t{0});
  CHECK_EQ(page_type(pager, tree.root()), PageType::BTreeInternal);
  const std::size_t height = tree_height(pager, tree.root());
  CHECK(height >= 2);

  const auto insert_ms =
      std::chrono::duration_cast<std::chrono::milliseconds>(insert_end -
                                                            insert_start)
          .count();
  const auto find_ms =
      std::chrono::duration_cast<std::chrono::milliseconds>(find_end -
                                                            find_start)
          .count();
  std::printf(
      "[btree] page_size=1024: 5000 inserts in %lld ms, 5000 finds in %lld ms, "
      "height=%llu pages=%llu\n",
      static_cast<long long>(insert_ms), static_cast<long long>(find_ms),
      static_cast<unsigned long long>(height),
      static_cast<unsigned long long>(pager.cached_pages()));
  std::fflush(stdout);

  expect_find(tree, expected);
  expect_scan(tree, expected);
}

IAQS_TEST(btree, reopen_pager_keeps_tree_usable) {
  TmpBTreeDir tmp;
  const std::vector<std::string> keys = random_keys(2000, 11);
  std::map<std::string, Rid, KeyLess> expected;
  for (std::size_t i = 0; i < keys.size(); ++i) {
    expected.emplace(keys[i], rid_for(static_cast<std::uint32_t>(i)));
  }

  PageRef root;
  {
    Pager pager(tmp.dir, 8192, 8192ull * 64);
    FixedBTree tree = FixedBTree::create(pager);
    for (const auto& entry : expected) tree.insert(span(entry.first), entry.second);
    root = tree.root();
    pager.sync();
  }
  {
    Pager pager(tmp.dir, 8192, 8192ull * 64);
    FixedBTree tree(pager, root);
    expect_find(tree, expected);
    expect_scan(tree, expected);
    // Mutate the reopened tree: insert new keys and remove some old ones.
    std::set<std::string> known;
    for (const auto& entry : expected) known.insert(entry.first);
    for (const std::string& key : random_keys(300, 12)) {
      if (!known.insert(key).second) continue;
      const Rid rid = rid_for(static_cast<std::uint32_t>(900000 + known.size()));
      expected.emplace(key, rid);
      tree.insert(span(key), rid);
    }
    std::vector<std::string> to_remove;
    for (const auto& entry : expected) {
      to_remove.push_back(entry.first);
      if (to_remove.size() >= 100) break;
    }
    for (const std::string& key : to_remove) {
      CHECK(tree.remove(span(key)));
      expected.erase(key);
    }
    root = tree.root();
    pager.sync();
  }
  Pager reopened(tmp.dir, 8192, 8192ull * 64);
  FixedBTree tree(reopened, root);
  expect_find(tree, expected);
  expect_scan(tree, expected);
}

IAQS_TEST(btree, rejects_bad_key_lengths) {
  TmpBTreeDir tmp;
  Pager pager(tmp.dir, 8192, 8192ull * 64);
  FixedBTree tree = FixedBTree::create(pager);
  const std::string short_key(FixedBTree::kKeySize - 1, 's');
  const std::string long_key(FixedBTree::kKeySize + 1, 'l');
  const Rid rid = rid_for(3);

  CHECK_THROW(tree.find(ByteSpan{}), std::runtime_error);
  CHECK_THROW(tree.find(span(short_key)), std::runtime_error);
  CHECK_THROW(tree.find(span(long_key)), std::runtime_error);
  CHECK_THROW(tree.insert(ByteSpan{}, rid), std::runtime_error);
  CHECK_THROW(tree.insert(span(short_key), rid), std::runtime_error);
  CHECK_THROW(tree.insert(span(long_key), rid), std::runtime_error);
  CHECK_THROW(tree.remove(ByteSpan{}), std::runtime_error);
  CHECK_THROW(tree.remove(span(short_key)), std::runtime_error);
  CHECK_THROW(tree.remove(span(long_key)), std::runtime_error);

  // A valid 32-byte key still works and nothing was stored by the failed calls.
  const std::string good_key(FixedBTree::kKeySize, 'g');
  tree.insert(span(good_key), rid);
  CHECK(tree.find(span(good_key)).has_value());
  CHECK_EQ(tree.scan().size(), std::size_t{1});
}

IAQS_TEST(btree, rid_roundtrip_exact_fields) {
  TmpBTreeDir tmp;
  Pager pager(tmp.dir, 8192, 8192ull * 64);
  FixedBTree tree = FixedBTree::create(pager);

  Rid first;
  first.ref = PageRef{0, 1, 0};
  first.slot = 0;
  Rid last_slot;
  last_slot.ref = PageRef{123, 45678, 0};
  last_slot.slot = 65535;
  Rid big;
  big.ref = PageRef{0xFFFFFFFFu, 0xFFFFFFFEu, 0};
  big.slot = 4242;
  const std::vector<std::pair<std::string, Rid>> inputs = {
      {std::string(FixedBTree::kKeySize, '\x10'), first},
      {std::string(FixedBTree::kKeySize, '\x20'), last_slot},
      {std::string(FixedBTree::kKeySize, '\x30'), big},
  };
  for (const auto& input : inputs) tree.insert(span(input.first), input.second);

  for (const auto& input : inputs) {
    const std::optional<Rid> found = tree.find(span(input.first));
    CHECK(found.has_value());
    if (!found) continue;
    CHECK_EQ(found->ref.seg, input.second.ref.seg);
    CHECK_EQ(found->ref.page, input.second.ref.page);
    CHECK_EQ(found->slot, input.second.slot);
    // The tree does not persist generations: consumers locate rows by
    // (seg, page) and HeapTable ignores the generation.
    CHECK_EQ(found->ref.generation, 0u);
  }
  const std::vector<std::pair<Bytes, Rid>> rows = tree.scan();
  CHECK_EQ(rows.size(), inputs.size());
  for (std::size_t i = 0; i < rows.size() && i < inputs.size(); ++i) {
    CHECK_EQ(rows[i].first, inputs[i].first);
    CHECK(same_rid(rows[i].second, inputs[i].second));
  }
}
