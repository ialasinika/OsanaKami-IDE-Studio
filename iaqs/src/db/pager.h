// Page cache over plaintext segment files. Addresses are PageRefs
// (segment, page, generation); every write bumps the generation. Dirty pages
// are framed into slots and written on flush(); WAL integration is layered on
// top.
#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <utility>
#include <vector>

#include "core/util.h"
#include "db/envelope.h"
#include "db/page.h"
#include "db/segment.h"

namespace iaqs::db {

struct CachedPage {
  PageRef ref;
  Bytes plain;
  bool dirty = false;
};

class Pager {
 public:
  Pager(std::string dir, uint32_t page_size, uint64_t segment_max);

  Pager(const Pager&) = delete;
  Pager& operator=(const Pager&) = delete;

  uint32_t page_size() const { return page_size_; }
  uint32_t segment_max_pages() const { return segment_max_pages_; }
  size_t segment_count() const { return segments_.size(); }
  size_t cached_pages() const { return cache_.size(); }
  size_t dirty_pages() const;

  // Allocates a fresh page (generation 1) and writes it immediately so the
  // address is durable/unique before the caller fills it in via update_page.
  PageRef alloc_page(PageType type, uint16_t flags, ByteSpan body);

  // Reads a page; throws std::runtime_error when the reference is stale or
  // the slot is corrupt.
  const Bytes& read_page(PageRef ref);

  // Overwrites a page with a new generation; marks it dirty until flush().
  PageRef update_page(PageRef ref, PageType type, uint16_t flags, ByteSpan body);

  // Seals and writes all dirty pages (no fsync).
  void flush();

  // flush() + flush OS buffers of every segment.
  void sync();

  // Sealed slot images (ref + slot bytes) of all dirty pages, in address
  // order, without writing them. Used to write WAL page records before the
  // pages themselves are flushed.
  std::vector<std::pair<PageRef, Bytes>> seal_dirty_pages() const;

  // WAL redo: writes an already-framed slot directly to storage and drops any
  // cached plaintext for that address.
  void redo_raw_slot(PageRef ref, ByteSpan slot);

  // Latest reference for an address: the cached page if present, otherwise the
  // generation stored in the slot's envelope header.
  PageRef current_ref(uint32_t seg, uint32_t page);

  // Drops one cached page (no-op when absent).
  void erase_cached(uint32_t seg, uint32_t page);

  // Drops clean pages from the cache; refuses when dirty pages are pending.
  void clear_cache();

  // Re-reads the on-disk segment list and page counts, discarding all cached
  // pages. Used by concurrent processes before starting a write transaction so
  // that they observe pages committed by other processes. Refuses when dirty
  // pages are pending (a transaction must be finished first).
  void refresh_from_disk();

  // Write-transaction baselines. update_page() snapshots a page's current
  // image the first time it is modified inside a transaction, so rollback can
  // restore committed state without losing pages that were only cached (not
  // yet flushed) by earlier commits.
  void begin_write_txn();
  void commit_write_txn();
  void rollback_write_txn();
  bool write_txn_active() const { return txn_active_; }

 private:
  static uint64_t cache_key(uint32_t seg, uint32_t page) {
    return (static_cast<uint64_t>(seg) << 32) | page;
  }

  SegmentFile& segment(uint32_t seg_id);
  SegmentFile& current_segment();
  void create_segment(uint32_t seg_id);
  void write_segment_header(SegmentFile& seg);
  void reload_segments();

  std::string dir_;
  uint32_t page_size_ = 0;
  uint64_t segment_max_ = 0;
  uint32_t segment_max_pages_ = 0;
  std::vector<SegmentFile> segments_;
  std::map<uint64_t, CachedPage> cache_;
  std::map<uint64_t, CachedPage> baseline_;
  bool txn_active_ = false;
};

}  // namespace iaqs::db
