#include "db/pager.h"

#include <algorithm>
#include <filesystem>
#include <stdexcept>

namespace iaqs::db {
namespace {

// Parses "seg-000123.dat" -> 123.
bool parse_segment_name(const std::string& name, uint32_t& out) {
  constexpr const char* kPrefix = "seg-";
  constexpr const char* kSuffix = ".dat";
  const size_t prefix_len = 4;
  const size_t suffix_len = 4;
  if (name.size() <= prefix_len + suffix_len) return false;
  if (name.compare(0, prefix_len, kPrefix) != 0) return false;
  if (name.compare(name.size() - suffix_len, suffix_len, kSuffix) != 0) {
    return false;
  }
  const std::string digits = name.substr(prefix_len, name.size() - prefix_len - suffix_len);
  if (digits.empty() || digits.size() > 9) return false;
  uint64_t value = 0;
  for (char c : digits) {
    if (c < '0' || c > '9') return false;
    value = value * 10 + static_cast<uint64_t>(c - '0');
  }
  if (value > 0xFFFFFFFFull) return false;
  out = static_cast<uint32_t>(value);
  return true;
}

}  // namespace

Pager::Pager(std::string dir, uint32_t page_size, uint64_t segment_max)
    : dir_(std::move(dir)),
      page_size_(page_size),
      segment_max_(segment_max) {
  if (page_size_ <= kEnvelopeHeaderSize + kPageHeaderSize) {
    throw std::runtime_error("Pager: page_size too small");
  }
  if (segment_max_ < 2ull * page_size_) segment_max_ = 2ull * page_size_;
  segment_max_pages_ = static_cast<uint32_t>(segment_max_ / page_size_);
  if (segment_max_pages_ < 2) segment_max_pages_ = 2;

  make_dirs(dir_);
  reload_segments();
}

void Pager::reload_segments() {
  segments_.clear();
  std::vector<uint32_t> ids;
  std::error_code ec;
  std::filesystem::directory_iterator it(std::filesystem::path(dir_), ec);
  if (ec) throw std::runtime_error("Pager: cannot list " + dir_);
  for (; it != std::filesystem::directory_iterator(); it.increment(ec)) {
    if (ec) throw std::runtime_error("Pager: cannot list " + dir_);
    const std::string name = it->path().filename().string();
    uint32_t id = 0;
    if (parse_segment_name(name, id)) ids.push_back(id);
  }
  std::sort(ids.begin(), ids.end());
  for (size_t i = 0; i < ids.size(); ++i) {
    if (ids[i] != i) {
      throw std::runtime_error("Pager: non-contiguous segment files in " + dir_);
    }
    segments_.push_back(SegmentFile::open(dir_, ids[i], page_size_));
  }
  if (segments_.empty()) create_segment(0);
}

void Pager::refresh_from_disk() {
  if (txn_active_) {
    throw std::runtime_error("Pager: cannot refresh inside a write transaction");
  }
  // Pages modified outside a transaction (index builds, catalog maintenance)
  // are this process's committed view; publish them before dropping the cache.
  if (dirty_pages() != 0) {
    flush();
    sync();
  }
  cache_.clear();
  baseline_.clear();
  reload_segments();
}

size_t Pager::dirty_pages() const {
  size_t n = 0;
  for (const auto& [k, v] : cache_) {
    (void)k;
    if (v.dirty) ++n;
  }
  return n;
}

void Pager::write_segment_header(SegmentFile& seg) {
  Bytes body;
  append_u32_le(body, seg.seg_id());
  append_u32_le(body, page_size_);
  const Bytes plain = encode_page(PageType::SegmentHeader, 0, 1, bytes_span(body));
  const PageRef ref{seg.seg_id(), 0, 1};
  const Bytes slot = seal_page(ref, bytes_span(plain), page_size_);
  seg.write_slot(0, bytes_span(slot));
}

void Pager::create_segment(uint32_t seg_id) {
  if (!segments_.empty() && segments_.back().seg_id() >= seg_id) {
    throw std::runtime_error("Pager: segment ids must increase");
  }
  SegmentFile seg = SegmentFile::create(dir_, seg_id, page_size_);
  write_segment_header(seg);
  seg.sync();
  segments_.push_back(std::move(seg));
}

SegmentFile& Pager::segment(uint32_t seg_id) {
  const auto& last = segments_.back();
  if (seg_id > last.seg_id()) {
    throw std::runtime_error("Pager: unknown segment");
  }
  // Segments are created contiguously in id order.
  SegmentFile& seg = segments_[seg_id];
  if (seg.seg_id() != seg_id) throw std::runtime_error("Pager: segment index mismatch");
  return seg;
}

SegmentFile& Pager::current_segment() {
  SegmentFile& seg = segments_.back();
  if (seg.page_count() >= segment_max_pages_) {
    create_segment(seg.seg_id() + 1);
    return segments_.back();
  }
  return seg;
}

PageRef Pager::alloc_page(PageType type, uint16_t flags, ByteSpan body) {
  if (body.size() > max_plain_page_size(page_size_) - kPageHeaderSize) {
    throw std::runtime_error("Pager: page body too large");
  }
  SegmentFile& seg = current_segment();
  const PageRef ref{seg.seg_id(), seg.page_count(), 1};
  const Bytes plain = encode_page(type, flags, ref.generation, body);
  const Bytes slot = seal_page(ref, bytes_span(plain), page_size_);
  seg.write_slot(ref.page, bytes_span(slot));
  cache_[cache_key(ref.seg, ref.page)] = CachedPage{ref, plain, false};
  return ref;
}

const Bytes& Pager::read_page(PageRef ref) {
  const uint64_t k = cache_key(ref.seg, ref.page);
  auto it = cache_.find(k);
  if (it != cache_.end()) {
    if (it->second.ref.generation != ref.generation) {
      throw std::runtime_error("Pager: stale page reference");
    }
    return it->second.plain;
  }

  SegmentFile& seg = segment(ref.seg);
  const Bytes slot = seg.read_slot(ref.page);
  EnvelopeInfo info;
  if (!read_envelope_info(bytes_span(slot), info)) {
    throw std::runtime_error("Pager: corrupt page envelope");
  }
  if (info.generation != ref.generation) {
    throw std::runtime_error("Pager: stale page reference");
  }
  Bytes plain = open_page(PageRef{ref.seg, ref.page, info.generation},
                          bytes_span(slot));
  auto [inserted, ok] = cache_.emplace(k, CachedPage{ref, std::move(plain), false});
  (void)ok;
  return inserted->second.plain;
}

PageRef Pager::update_page(PageRef ref, PageType type, uint16_t flags,
                           ByteSpan body) {
  if (body.size() > max_plain_page_size(page_size_) - kPageHeaderSize) {
    throw std::runtime_error("Pager: page body too large");
  }
  // Reject stale references before mutating: read-through validates the
  // current generation.
  read_page(ref);
  const uint64_t k = cache_key(ref.seg, ref.page);
  if (txn_active_) baseline_.emplace(k, cache_.at(k));
  const PageRef next{ref.seg, ref.page, ref.generation + 1};
  const Bytes plain = encode_page(type, flags, next.generation, body);
  cache_[k] = CachedPage{next, plain, true};
  return next;
}

void Pager::flush() {
  for (auto& [k, entry] : cache_) {
    (void)k;
    if (!entry.dirty) continue;
    SegmentFile& seg = segment(entry.ref.seg);
    const Bytes slot = seal_page(entry.ref, bytes_span(entry.plain), page_size_);
    seg.write_slot(entry.ref.page, bytes_span(slot));
    entry.dirty = false;
  }
}

void Pager::sync() {
  flush();
  for (auto& seg : segments_) seg.sync();
}

std::vector<std::pair<PageRef, Bytes>> Pager::seal_dirty_pages() const {
  std::vector<std::pair<PageRef, Bytes>> sealed;
  for (const auto& [k, entry] : cache_) {
    (void)k;
    if (!entry.dirty) continue;
    sealed.emplace_back(entry.ref,
                        seal_page(entry.ref, bytes_span(entry.plain), page_size_));
  }
  return sealed;
}

void Pager::redo_raw_slot(PageRef ref, ByteSpan slot) {
  SegmentFile& seg = segment(ref.seg);
  seg.write_slot(ref.page, slot);
  cache_.erase(cache_key(ref.seg, ref.page));
}

PageRef Pager::current_ref(uint32_t seg_id, uint32_t page) {
  const auto it = cache_.find(cache_key(seg_id, page));
  if (it != cache_.end()) return it->second.ref;
  SegmentFile& seg = segment(seg_id);
  const Bytes slot = seg.read_slot(page);
  EnvelopeInfo info;
  if (!read_envelope_info(bytes_span(slot), info)) {
    throw std::runtime_error("Pager: corrupt page envelope");
  }
  return PageRef{seg_id, page, info.generation};
}

void Pager::erase_cached(uint32_t seg_id, uint32_t page) {
  cache_.erase(cache_key(seg_id, page));
}

void Pager::clear_cache() {
  if (dirty_pages() != 0) {
    throw std::runtime_error("Pager: cannot clear cache with dirty pages");
  }
  cache_.clear();
}

void Pager::begin_write_txn() {
  if (txn_active_) throw std::runtime_error("Pager: transaction already active");
  baseline_.clear();
  txn_active_ = true;
}

void Pager::commit_write_txn() {
  txn_active_ = false;
  baseline_.clear();
}

void Pager::rollback_write_txn() {
  if (!txn_active_) return;
  for (auto& [key, entry] : baseline_) {
    // Mark restored images dirty: they may only have existed in the cache
    // (earlier commits do not flush), so the next checkpoint must persist them.
    entry.dirty = true;
    cache_[key] = std::move(entry);
  }
  baseline_.clear();
  txn_active_ = false;
}

}  // namespace iaqs::db
