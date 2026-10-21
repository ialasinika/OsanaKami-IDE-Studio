#include "db/pager.h"

#include <filesystem>
#include <stdexcept>
#include <string>

#include "core/util.h"
#include "crypto/rand.h"
#include "db/keys.h"
#include "db/page.h"
#include "harness.h"

using namespace iaqs;
using namespace iaqs::db;

namespace {

std::string make_tmp_dir() {
  const std::string name = "iaqs-pager-" + to_hex(bytes_span(random_bytes(8)));
  const std::string dir =
      (std::filesystem::temp_directory_path() / name).string();
  make_dirs(dir);
  return dir;
}

void remove_tmp_dir(const std::string& dir) {
  std::error_code ec;
  std::filesystem::remove_all(std::filesystem::path(dir), ec);
}

Key32 test_key() {
  Key32 key{};
  for (size_t i = 0; i < key.size(); ++i) key[i] = static_cast<uint8_t>(i * 7 + 3);
  return key;
}

Bytes make_body(const std::string& text) { return Bytes(text); }

std::string body_of(const Bytes& plain) {
  PageHeader header;
  ByteSpan body;
  if (!decode_page(bytes_span(plain), header, body)) {
    throw std::runtime_error("test: invalid page");
  }
  return std::string(reinterpret_cast<const char*>(body.data()), body.size());
}

struct TmpPagerDir {
  std::string dir = make_tmp_dir();
  ~TmpPagerDir() { remove_tmp_dir(dir); }
};

}  // namespace

IAQS_TEST(pager, alloc_read_and_update) {
  TmpPagerDir tmp;
  Pager pager(tmp.dir, 4096, 4096ull * 8, test_key(), /*epoch=*/3);
  CHECK_EQ(pager.segment_count(), 1u);

  const PageRef first =
      pager.alloc_page(PageType::Heap, 0, bytes_span(make_body("hello")));
  CHECK_EQ(first.seg, 0u);
  CHECK_EQ(first.page, 1u);
  CHECK_EQ(first.generation, 1u);
  CHECK_EQ(body_of(pager.read_page(first)), std::string("hello"));

  const PageRef second =
      pager.update_page(first, PageType::Heap, 0, bytes_span(make_body("world!")));
  CHECK_EQ(second.generation, 2u);
  CHECK_EQ(body_of(pager.read_page(second)), std::string("world!"));
  CHECK_THROW(pager.read_page(first), std::runtime_error);
}

IAQS_TEST(pager, flush_and_reopen_persists_data) {
  TmpPagerDir tmp;
  const Key32 key = test_key();
  PageRef ref;
  {
    Pager pager(tmp.dir, 4096, 4096ull * 8, key, 5);
    ref = pager.alloc_page(PageType::BTreeLeaf, 0, bytes_span(make_body("abc")));
    ref = pager.update_page(ref, PageType::BTreeLeaf, 0,
                            bytes_span(make_body("persisted")));
    CHECK_EQ(pager.dirty_pages(), 1u);
    pager.sync();
    CHECK_EQ(pager.dirty_pages(), 0u);
  }
  Pager reopened(tmp.dir, 4096, 4096ull * 8, key, 5);
  CHECK_EQ(body_of(reopened.read_page(ref)), std::string("persisted"));
  // A reference from before the update is stale.
  CHECK_THROW(reopened.read_page(PageRef{ref.seg, ref.page, 1}),
              std::runtime_error);
}

IAQS_TEST(pager, segment_rotation) {
  TmpPagerDir tmp;
  // 4 pages per segment: page 0 = header, pages 1..3 = data.
  Pager pager(tmp.dir, 1024, 1024ull * 4, test_key(), 0);
  std::vector<PageRef> refs;
  for (int i = 0; i < 6; ++i) {
    refs.push_back(pager.alloc_page(PageType::Heap, 0,
                                    bytes_span(make_body("page"))));
  }
  CHECK(pager.segment_count() >= 2);
  CHECK_EQ(refs[0].seg, 0u);
  CHECK_EQ(refs[0].page, 1u);
  CHECK_EQ(refs[3].seg, 1u);
  CHECK_EQ(refs[3].page, 1u);
  for (const PageRef& ref : refs) {
    CHECK_EQ(body_of(pager.read_page(ref)), std::string("page"));
  }
  pager.sync();

  Pager reopened(tmp.dir, 1024, 1024ull * 4, test_key(), 0);
  CHECK_EQ(reopened.segment_count(), pager.segment_count());
  for (const PageRef& ref : refs) {
    CHECK_EQ(body_of(reopened.read_page(ref)), std::string("page"));
  }
}

IAQS_TEST(pager, corrupt_slot_is_rejected) {
  TmpPagerDir tmp;
  const Key32 key = test_key();
  PageRef ref;
  {
    Pager pager(tmp.dir, 4096, 4096ull * 8, key, 0);
    ref = pager.alloc_page(PageType::Heap, 0, bytes_span(make_body("data")));
    pager.sync();
  }
  // Flip a byte inside the ciphertext of page 1's slot.
  const std::string path = SegmentFile::path_for(tmp.dir, 0);
  Bytes raw = read_file(path);
  const size_t offset = 1 * 4096 + kEnvelopeHeaderSize + 3;
  CHECK(offset < raw.size());
  raw[offset] = static_cast<char>(raw[offset] ^ 0x40);
  write_file_atomic(path, bytes_span(raw));

  Pager pager(tmp.dir, 4096, 4096ull * 8, key, 0);
  CHECK_THROW(pager.read_page(ref), std::runtime_error);
}

IAQS_TEST(pager, oversized_body_rejected) {
  TmpPagerDir tmp;
  Pager pager(tmp.dir, 1024, 1024ull * 8, test_key(), 0);
  const Bytes too_big(max_plain_page_size(1024) - kPageHeaderSize + 1, 'x');
  CHECK_THROW(pager.alloc_page(PageType::Heap, 0, bytes_span(too_big)),
              std::runtime_error);
  const PageRef ref =
      pager.alloc_page(PageType::Heap, 0, bytes_span(make_body("ok")));
  CHECK_THROW(pager.update_page(ref, PageType::Heap, 0, bytes_span(too_big)),
              std::runtime_error);
}

IAQS_TEST(pager, clear_cache_requires_flush) {
  TmpPagerDir tmp;
  Pager pager(tmp.dir, 4096, 4096ull * 8, test_key(), 0);
  const PageRef ref =
      pager.alloc_page(PageType::Heap, 0, bytes_span(make_body("a")));
  pager.update_page(ref, PageType::Heap, 0, bytes_span(make_body("b")));
  CHECK_THROW(pager.clear_cache(), std::runtime_error);
  pager.flush();
  pager.clear_cache();
  CHECK_EQ(pager.cached_pages(), 0u);
  CHECK_EQ(body_of(pager.read_page(PageRef{ref.seg, ref.page, 2})),
           std::string("b"));
}
