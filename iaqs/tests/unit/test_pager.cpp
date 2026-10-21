#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "core/util.h"
#include "db/page.h"
#include "db/pager.h"
#include "db/segment.h"
#include "harness.h"

using namespace iaqs;
using namespace iaqs::db;

namespace {

class TempDir {
 public:
  explicit TempDir(const std::string& name)
      : path_((std::filesystem::temp_directory_path() /
               ("iaqs_test_pager_" + name))
                  .string()) {
    std::error_code ignored;
    std::filesystem::remove_all(path_, ignored);
    std::filesystem::create_directories(path_);
  }
  ~TempDir() {
    std::error_code ignored;
    std::filesystem::remove_all(path_, ignored);
  }
  TempDir(const TempDir&) = delete;
  TempDir& operator=(const TempDir&) = delete;
  const std::string& str() const { return path_; }

 private:
  std::string path_;
};

Bytes body_of(size_t size, char base) {
  Bytes out(size, '\0');
  for (size_t i = 0; i < size; ++i) out[i] = static_cast<char>(base + (i % 17));
  return out;
}

// read_page() hands back the encoded page (header + body); tests care about the
// body they wrote.
Bytes body_of_page(Pager& pager, PageRef ref) {
  const Bytes& plain = pager.read_page(ref);
  PageHeader header;
  ByteSpan body;
  CHECK(decode_page(bytes_span(plain), header, body));
  (void)header;
  return Bytes(bytes_view(body));
}

void flip_byte(const std::string& path, uint64_t offset) {
  Bytes data = read_file(path);
  CHECK(offset < data.size());
  data[offset] = static_cast<char>(data[offset] ^ 0x01);
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  out.write(data.data(), static_cast<std::streamsize>(data.size()));
}

}  // namespace

IAQS_TEST(pager, alloc_read_and_update) {
  TempDir dir("alloc");
  Pager pager(dir.str(), 4096, 4096ull * 8);

  const Bytes body = body_of(256, 'a');
  const PageRef first = pager.alloc_page(PageType::Heap, 0, bytes_span(body));
  CHECK_EQ(first.seg, 0u);
  CHECK_EQ(first.page, 1u);
  CHECK_EQ(first.generation, 1u);
  CHECK(body_of_page(pager, first) == body);

  const Bytes updated = body_of(300, 'b');
  const PageRef second = pager.update_page(first, PageType::Heap, 1, bytes_span(updated));
  CHECK_EQ(second.seg, first.seg);
  CHECK_EQ(second.page, first.page);
  CHECK_EQ(second.generation, 2u);
  pager.flush();
  CHECK(body_of_page(pager, second) == updated);
  // The superseded address is stale, not silently misread.
  CHECK_THROW(pager.read_page(first), std::runtime_error);
}

IAQS_TEST(pager, flush_and_reopen_persists_data) {
  TempDir dir("persist");
  const uint32_t page_size = 4096;
  Bytes updated;
  {
    Pager pager(dir.str(), page_size, page_size * 8ull);
    const PageRef first = pager.alloc_page(PageType::Heap, 0, bytes_span(body_of(128, 'a')));
    updated = body_of(200, 'b');
    pager.update_page(first, PageType::Heap, 0, bytes_span(updated));
    pager.flush();
  }
  Pager reopened(dir.str(), page_size, page_size * 8ull);
  const PageRef latest = reopened.current_ref(0, 1);
  CHECK_EQ(latest.generation, 2u);
  CHECK(body_of_page(reopened, latest) == updated);
}

IAQS_TEST(pager, segment_rotation) {
  TempDir dir("rotate");
  const uint32_t page_size = 1024;
  Pager pager(dir.str(), page_size, 4096);  // four slots per segment
  std::vector<PageRef> refs;
  for (int i = 0; i < 4; ++i) {
    refs.push_back(pager.alloc_page(PageType::Heap, 0, bytes_span(body_of(64, 'a' + i))));
  }
  CHECK_EQ(refs[0].seg, 0u);
  CHECK_EQ(refs[0].page, 1u);
  CHECK_EQ(refs[3].seg, 1u);
  CHECK_EQ(refs[3].page, 1u);
  CHECK_EQ(pager.segment_count(), 2u);
}

IAQS_TEST(pager, corrupt_slot_is_rejected) {
  TempDir dir("corrupt");
  const uint32_t page_size = 4096;
  {
    Pager pager(dir.str(), page_size, page_size * 8ull);
    pager.alloc_page(PageType::Heap, 0, bytes_span(body_of(100, 'z')));
    pager.flush();
  }
  const std::string segment = SegmentFile::path_for(dir.str(), 0);
  flip_byte(segment, page_size + kEnvelopeHeaderSize + 5);

  Pager pager(dir.str(), page_size, page_size * 8ull);
  CHECK_THROW(pager.read_page(PageRef{0, 1, 1}), std::runtime_error);
}

IAQS_TEST(pager, oversized_body_rejected) {
  TempDir dir("oversized");
  const uint32_t page_size = 4096;
  Pager pager(dir.str(), page_size, page_size * 8ull);
  const Bytes too_big(max_plain_page_size(page_size) - kPageHeaderSize + 1, 'x');
  CHECK_THROW(pager.alloc_page(PageType::Heap, 0, bytes_span(too_big)),
              std::runtime_error);
}

IAQS_TEST(pager, clear_cache_requires_flush) {
  TempDir dir("cache");
  const uint32_t page_size = 4096;
  Pager pager(dir.str(), page_size, page_size * 8ull);
  const PageRef first = pager.alloc_page(PageType::Heap, 0, bytes_span(body_of(64, 'a')));
  const Bytes updated = body_of(80, 'b');
  const PageRef second = pager.update_page(first, PageType::Heap, 0, bytes_span(updated));

  CHECK_THROW(pager.clear_cache(), std::runtime_error);
  pager.flush();
  pager.clear_cache();
  CHECK_EQ(pager.cached_pages(), 0u);
  CHECK(body_of_page(pager, second) == updated);
}
