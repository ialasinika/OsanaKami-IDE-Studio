#include "db/heap.h"

#include <cstring>
#include <stdexcept>

namespace iaqs::db {
namespace {

// Page body layout:
//   [u32 next_seg][u32 next_page][u32 next_generation][u16 slot_count]
//   [u16 data_start][slot array: (u16 offset, u16 len)] ... [record area]
// Offsets are relative to the page body. Records grow downwards from the end of
// the body; data_start is the lowest record offset, i.e. the free-space upper
// bound. A slot with len == 0 and offset == 0 is a tombstone; an empty record
// keeps a valid record-area offset so the two stay distinguishable.
constexpr size_t kHeapHeaderSize = 16;
constexpr size_t kSlotSize = 4;
constexpr size_t kMaxChainPages = size_t{1} << 21;

struct PageView {
  PageRef ref;
  PageRef next;  // (0,0,0) when this is the last page of the chain
  uint16_t slot_count = 0;
  uint16_t data_start = 0;
  Bytes body;
};

struct Slot {
  uint16_t offset = 0;
  uint16_t len = 0;
};

bool is_null_ref(const PageRef& ref) {
  return ref.seg == 0 && ref.page == 0 && ref.generation == 0;
}

bool same_page(const PageRef& a, const PageRef& b) {
  return a.seg == b.seg && a.page == b.page;
}

uint16_t page_capacity(const Pager& pager) {
  const size_t capacity = max_plain_page_size(pager.page_size()) - kPageHeaderSize;
  if (capacity < kHeapHeaderSize + kSlotSize || capacity > 0xFFFF) {
    throw std::runtime_error("HeapTable: unsupported page size");
  }
  return static_cast<uint16_t>(capacity);
}

// Creates an empty page body of the full page capacity.
Bytes empty_body(uint16_t capacity) {
  Bytes body(capacity, '\0');
  uint8_t* p = reinterpret_cast<uint8_t*>(body.data());
  store_u16_le(p + 12, 0);  // slot_count
  store_u16_le(p + 14, capacity);  // data_start
  return body;
}

void encode_header(PageView& page) {
  uint8_t* p = reinterpret_cast<uint8_t*>(page.body.data());
  store_u32_le(p, page.next.seg);
  store_u32_le(p + 4, page.next.page);
  store_u32_le(p + 8, page.next.generation);
  store_u16_le(p + 12, page.slot_count);
  store_u16_le(p + 14, page.data_start);
}

Slot read_slot(const PageView& page, uint16_t index) {
  const uint8_t* p = reinterpret_cast<const uint8_t*>(page.body.data()) +
                     kHeapHeaderSize + static_cast<size_t>(index) * kSlotSize;
  Slot slot;
  slot.offset = load_u16_le(p);
  slot.len = load_u16_le(p + 2);
  return slot;
}

void write_slot(PageView& page, uint16_t index, Slot slot) {
  uint8_t* p = reinterpret_cast<uint8_t*>(page.body.data()) +
               kHeapHeaderSize + static_cast<size_t>(index) * kSlotSize;
  store_u16_le(p, slot.offset);
  store_u16_le(p + 2, slot.len);
}

bool slot_alive(Slot slot) { return slot.len != 0 || slot.offset != 0; }

PageView load_page(Pager& pager, PageRef ref) {
  const Bytes& plain = pager.read_page(ref);
  PageHeader header;
  ByteSpan body;
  if (!decode_page(bytes_span(plain), header, body)) {
    throw std::runtime_error("HeapTable: corrupt page " + page_ref_to_string(ref));
  }
  if (header.type != PageType::Heap) {
    throw std::runtime_error("HeapTable: page is not a heap page " +
                             page_ref_to_string(ref));
  }
  if (body.size() < kHeapHeaderSize || body.size() > 0xFFFF) {
    throw std::runtime_error("HeapTable: bad heap page body " +
                             page_ref_to_string(ref));
  }
  PageView page;
  page.ref = ref;
  page.body.assign(bytes_view(body));
  const uint8_t* p = reinterpret_cast<const uint8_t*>(page.body.data());
  page.next = PageRef{load_u32_le(p), load_u32_le(p + 4), load_u32_le(p + 8)};
  page.slot_count = load_u16_le(p + 12);
  page.data_start = load_u16_le(p + 14);

  const uint16_t capacity = static_cast<uint16_t>(page.body.size());
  const size_t slot_end =
      kHeapHeaderSize + static_cast<size_t>(page.slot_count) * kSlotSize;
  if (slot_end > capacity || page.data_start < slot_end ||
      page.data_start > capacity) {
    throw std::runtime_error("HeapTable: corrupt slotted page header " +
                             page_ref_to_string(ref));
  }
  if (!is_null_ref(page.next) && page.next.page == 0) {
    throw std::runtime_error("HeapTable: corrupt heap page link " +
                             page_ref_to_string(ref));
  }
  for (uint16_t i = 0; i < page.slot_count; ++i) {
    const Slot slot = read_slot(page, i);
    if (!slot_alive(slot)) continue;
    if (slot.offset < slot_end ||
        static_cast<size_t>(slot.offset) + slot.len > capacity) {
      throw std::runtime_error("HeapTable: corrupt heap slot " +
                               page_ref_to_string(ref));
    }
  }
  return page;
}

PageRef store_page(Pager& pager, PageView& page) {
  encode_header(page);
  page.ref = pager.update_page(page.ref, PageType::Heap, 0, bytes_span(page.body));
  return page.ref;
}

bool has_room(const PageView& page, size_t record_size) {
  if (record_size > 0xFFFF || record_size > page.data_start) return false;
  const size_t slot_end =
      kHeapHeaderSize + (static_cast<size_t>(page.slot_count) + 1) * kSlotSize;
  if (slot_end > page.data_start) return false;
  return page.data_start - record_size >= slot_end;
}

void put_record(PageView& page, ByteSpan record) {
  const uint16_t offset = static_cast<uint16_t>(page.data_start - record.size());
  if (!record.empty()) {
    std::memcpy(page.body.data() + offset, record.data(), record.size());
  }
  const size_t slot_pos =
      kHeapHeaderSize + static_cast<size_t>(page.slot_count) * kSlotSize;
  uint8_t* p = reinterpret_cast<uint8_t*>(page.body.data());
  store_u16_le(p + slot_pos, offset);
  store_u16_le(p + slot_pos + 2, static_cast<uint16_t>(record.size()));
  page.slot_count = static_cast<uint16_t>(page.slot_count + 1);
  page.data_start = offset;
}

// Loads the chain from `root`. When `match` is null the whole path down to the
// tail page is returned; otherwise the path stops at the page whose (seg, page)
// equals match (an empty result means "not in this heap"). PageRef generations
// in `match` are ignored so a reference issued before a page rewrite still
// resolves.
std::vector<PageView> load_path(Pager& pager, PageRef root, const PageRef* match) {
  std::vector<PageView> path;
  PageRef current = root;
  for (size_t steps = 0; steps < kMaxChainPages; ++steps) {
    path.push_back(load_page(pager, current));
    const PageView& page = path.back();
    if (match != nullptr && same_page(page.ref, *match)) return path;
    if (is_null_ref(page.next)) {
      if (match == nullptr) return path;
      return {};
    }
    current = page.next;
  }
  throw std::runtime_error("HeapTable: heap page chain is cyclic or too long");
}

// Pager references embed the generation and every write bumps it, so writing a
// page invalidates its incoming link. To keep on-disk links exact we re-point
// the whole root->page path, from `from` (already modified) up to the root.
// M1 simplification: a write costs O(chain depth).
PageRef write_path(Pager& pager, std::vector<PageView>& path, size_t from) {
  PageRef child = store_page(pager, path[from]);
  for (size_t i = from; i-- > 0;) {
    path[i].next = child;
    child = store_page(pager, path[i]);
  }
  return child;
}

}  // namespace

HeapTable::HeapTable(Pager& pager, PageRef root) : pager_(pager), root_(root) {}

PageRef HeapTable::create(Pager& pager) {
  const uint16_t capacity = page_capacity(pager);
  return pager.alloc_page(PageType::Heap, 0, bytes_span(empty_body(capacity)));
}

PageRef HeapTable::root() const { return root_; }

Rid HeapTable::insert(ByteSpan record) {
  const uint16_t capacity = page_capacity(pager_);
  if (record.size() > static_cast<size_t>(capacity) - kHeapHeaderSize - kSlotSize) {
    throw std::runtime_error("HeapTable: record does not fit in a heap page");
  }
  std::vector<PageView> path = load_path(pager_, root_, nullptr);
  PageView& tail = path.back();
  if (has_room(tail, record.size())) {
    const uint16_t slot = tail.slot_count;
    put_record(tail, record);
    root_ = write_path(pager_, path, path.size() - 1);
    return Rid{tail.ref, slot};
  }

  // The tail is full: build a page that already holds the record, then link it
  // after the current tail. Building it first keeps the new page's generation
  // final, so the link written by write_path() is exact.
  PageView fresh;
  fresh.body = empty_body(capacity);
  fresh.data_start = capacity;
  put_record(fresh, record);
  encode_header(fresh);
  fresh.ref = pager_.alloc_page(PageType::Heap, 0, bytes_span(fresh.body));
  tail.next = fresh.ref;
  root_ = write_path(pager_, path, path.size() - 1);
  return Rid{fresh.ref, 0};
}

Bytes HeapTable::get(Rid rid) {
  std::vector<PageView> path = load_path(pager_, root_, &rid.ref);
  if (path.empty()) {
    throw std::runtime_error("HeapTable: rid does not reference a live heap page");
  }
  const PageView& page = path.back();
  if (rid.slot >= page.slot_count) {
    throw std::runtime_error("HeapTable: rid slot out of range");
  }
  const Slot slot = read_slot(page, rid.slot);
  if (!slot_alive(slot)) {
    throw std::runtime_error("HeapTable: rid row was removed");
  }
  const char* data = page.body.data() + slot.offset;
  return Bytes(data, slot.len);
}

bool HeapTable::remove(Rid rid) {
  std::vector<PageView> path = load_path(pager_, root_, &rid.ref);
  if (path.empty()) return false;
  PageView& page = path.back();
  if (rid.slot >= page.slot_count) return false;
  const Slot slot = read_slot(page, rid.slot);
  if (!slot_alive(slot)) return false;
  write_slot(page, rid.slot, Slot{});
  root_ = write_path(pager_, path, path.size() - 1);
  return true;
}

std::vector<Rid> HeapTable::scan() {
  std::vector<Rid> rids;
  PageRef current = root_;
  for (size_t steps = 0; steps < kMaxChainPages; ++steps) {
    const PageView page = load_page(pager_, current);
    for (uint16_t i = 0; i < page.slot_count; ++i) {
      if (!slot_alive(read_slot(page, i))) continue;
      rids.push_back(Rid{page.ref, i});
    }
    if (is_null_ref(page.next)) return rids;
    current = page.next;
  }
  throw std::runtime_error("HeapTable: heap page chain is cyclic or too long");
}

}  // namespace iaqs::db
