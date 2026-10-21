#include "db/database.h"

#include "core/lock.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <stdexcept>
#include <system_error>
#include <type_traits>

#include "db/manifest.h"
#include "db/segment.h"

namespace iaqs::db {
namespace {

constexpr uint64_t kAutoCheckpointWalBytes = 8ull * 1024 * 1024;

std::string manifest_path(const std::string& dir) { return dir + "/MANIFEST"; }

// ---------------------------------------------------------------- catalog

struct CatalogCursor {
  ByteSpan data;
  size_t pos = 0;

  void need(size_t n) const {
    if (pos + n > data.size()) throw std::runtime_error("catalog: truncated");
  }
  uint16_t u16() {
    need(2);
    const uint16_t v = load_u16_le(data.data() + pos);
    pos += 2;
    return v;
  }
  uint32_t u32() {
    need(4);
    const uint32_t v = load_u32_le(data.data() + pos);
    pos += 4;
    return v;
  }
  uint8_t u8() {
    need(1);
    const uint8_t v = data.data()[pos];
    pos += 1;
    return v;
  }
  Bytes str() {
    const uint16_t n = u16();
    need(n);
    Bytes s(reinterpret_cast<const char*>(data.data() + pos), n);
    pos += n;
    return s;
  }
  bool done() const { return pos == data.size(); }
};

Bytes encode_catalog(uint32_t wal_gen,
                     const std::map<std::string, TableInfo>& tables,
                     const std::map<std::string, IndexInfo>& indexes) {
  Bytes out;
  append_u32_le(out, wal_gen);
  append_u32_le(out, static_cast<uint32_t>(tables.size()));
  for (const auto& [name, info] : tables) {
    append_u16_le(out, static_cast<uint16_t>(name.size()));
    out.append(name);
    append_u32_le(out, info.root_seg);
    append_u32_le(out, info.root_page);
    append_u16_le(out, static_cast<uint16_t>(info.schema.columns.size()));
    for (const ColumnDef& col : info.schema.columns) {
      append_u16_le(out, static_cast<uint16_t>(col.name.size()));
      out.append(col.name);
      out.push_back(static_cast<char>(static_cast<uint8_t>(col.type)));
      uint8_t flags = 0;
      if (col.primary_key) flags |= 0x01;
      if (col.not_null) flags |= 0x02;
      out.push_back(static_cast<char>(flags));
    }
  }
  // Secondary indexes follow the tables: name, owning table, indexed column,
  // the column's value type and the B+ tree root page.
  append_u32_le(out, static_cast<uint32_t>(indexes.size()));
  for (const auto& [name, index] : indexes) {
    append_u16_le(out, static_cast<uint16_t>(name.size()));
    out.append(name);
    append_u16_le(out, static_cast<uint16_t>(index.table.size()));
    out.append(index.table);
    append_u16_le(out, static_cast<uint16_t>(index.column.size()));
    out.append(index.column);
    out.push_back(static_cast<char>(static_cast<uint8_t>(index.type)));
    append_u32_le(out, index.root_seg);
    append_u32_le(out, index.root_page);
  }
  return out;
}

struct CatalogData {
  uint32_t wal_gen = 0;
  std::map<std::string, TableInfo> tables;
  std::map<std::string, IndexInfo> indexes;
};

CatalogData decode_catalog(ByteSpan body) {
  CatalogCursor c{body};
  CatalogData data;
  data.wal_gen = c.u32();
  const uint32_t count = c.u32();
  for (uint32_t i = 0; i < count; ++i) {
    TableInfo info;
    info.schema.name = c.str();
    info.root_seg = c.u32();
    info.root_page = c.u32();
    const uint16_t ncols = c.u16();
    for (uint16_t col = 0; col < ncols; ++col) {
      ColumnDef def;
      def.name = c.str();
      // Encoder writes the value type and flag byte back to back; read them as
      // one little-endian pair and split it again.
      const uint16_t type_and_flags = c.u16();
      def.type = static_cast<ValueType>(type_and_flags & 0xff);
      const uint8_t flags = static_cast<uint8_t>(type_and_flags >> 8);
      def.primary_key = (flags & 0x01) != 0;
      def.not_null = (flags & 0x02) != 0;
      info.schema.columns.push_back(std::move(def));
    }
    data.tables.emplace(info.schema.name, std::move(info));
  }
  // Optional trailing index section: catalogs written before M2 end right after
  // the tables, so a missing section means "no indexes" (backward compatible).
  const uint32_t index_count = c.done() ? 0 : c.u32();
  for (uint32_t i = 0; i < index_count; ++i) {
    IndexInfo index;
    index.name = c.str();
    index.table = c.str();
    index.column = c.str();
    index.type = static_cast<ValueType>(c.u8());
    index.root_seg = c.u32();
    index.root_page = c.u32();
    data.indexes.emplace(index.name, std::move(index));
  }
  if (!c.done()) throw std::runtime_error("catalog: trailing bytes");
  return data;
}

void validate_schema(const TableSchema& schema) {
  if (schema.name.empty()) throw std::runtime_error("table name is empty");
  if (schema.columns.empty()) throw std::runtime_error("table has no columns");
  std::map<std::string, int> seen;
  for (const ColumnDef& col : schema.columns) {
    if (col.name.empty()) throw std::runtime_error("column name is empty");
    if (++seen[col.name] > 1) {
      throw std::runtime_error("duplicate column: " + col.name);
    }
  }
}

// Case-insensitive column lookup, -1 when missing.
int find_column(const TableSchema& schema, std::string_view name) {
  const std::string lower = to_lower_ascii(name);
  for (std::size_t i = 0; i < schema.columns.size(); ++i) {
    if (to_lower_ascii(schema.columns[i].name) == lower) {
      return static_cast<int>(i);
    }
  }
  return -1;
}

// Runs `fn` inside a transaction, committing it when this call owns it.
template <typename Fn>
auto auto_txn(Database& db, Fn&& fn) {
  using Result = std::invoke_result_t<Fn>;
  const bool own = !db.in_transaction();
  if (own) db.begin();
  try {
    if constexpr (std::is_void_v<Result>) {
      fn();
      if (own) db.commit();
    } else {
      Result result = fn();
      if (own) db.commit();
      return result;
    }
  } catch (...) {
    if (own) {
      try {
        db.rollback();
      } catch (...) {
      }
    }
    throw;
  }
}

}  // namespace

// ---------------------------------------------------------------- lifecycle

Database::~Database() {
  if (pager_) {
    try {
      checkpoint();
    } catch (...) {
      // A destructor must not throw; committed data is already in the WAL.
    }
  }
  wal_.reset();
  pager_.reset();
  lock_.reset();
}

Database Database::create(const std::string& dir, uint32_t page_size) {
  const std::string mp = manifest_path(dir);
  if (file_exists(mp)) {
    throw std::runtime_error("database already exists: " + dir);
  }
  make_dirs(dir);
  Database db;
  // Creation is exclusive: no other process may see a half-written database.
  const bool locked = db.acquire_write_lock(dir);
  const Manifest manifest = Manifest::create(page_size, kDefaultSegmentMax);
  save_manifest(mp, manifest);

  db.initialize_common(dir, manifest);
  db.wal_gen_ = 0;
  db.catalog_ref_ = db.pager_->alloc_page(PageType::System, 0, {});
  db.reset_wal_after_checkpoint();
  db.release_write_lock(locked);
  return db;
}

Database Database::open(const std::string& dir) {
  const std::string mp = manifest_path(dir);
  if (!file_exists(mp)) {
    throw std::runtime_error("not a database (missing MANIFEST): " + dir);
  }
  Database db;
  // Opening is a short exclusive section: replay the WAL and check point. Once
  // open returns, readers only touch page files and take no lock; writers
  // re-acquire it per transaction.
  const bool locked = db.acquire_write_lock(dir);
  db.initialize_common(dir, load_manifest(mp));
  db.recover();
  db.load_catalog();
  db.reset_wal_after_checkpoint();
  db.release_write_lock(locked);
  return db;
}

void Database::initialize_common(const std::string& dir, Manifest manifest) {
  dir_ = dir;
  manifest_ = manifest;
  pager_ = std::make_unique<Pager>(dir_, manifest_.page_size,
                                   manifest_.segment_max);
}

void Database::checkpoint() {
  if (tx_active_) {
    throw std::runtime_error("checkpoint inside an active transaction");
  }
  const bool locked = acquire_write_lock();
  try {
    reset_wal_after_checkpoint();
  } catch (...) {
    release_write_lock(locked);
    throw;
  }
  release_write_lock(locked);
}

void Database::close() {
  if (pager_) checkpoint();
  wal_.reset();
  pager_.reset();
  lock_.reset();
}

// ------------------------------------------------------------ concurrency

bool Database::acquire_write_lock(const std::string& dir) {
  if (lock_) return false;
  const std::string target = dir.empty() ? dir_ : dir;
  lock_ = std::make_unique<FileLock>(
      FileLock::acquire_wait(target + "/locked"));
  return true;
}

void Database::release_write_lock(bool acquired) {
  if (acquired) lock_.reset();
}

// WAL segment ids must never repeat even after a checkpoint deletes every
// wal-*.log. A small sidecar file remembers the next id across WAL deletions
// (files are also scanned as a fallback).
std::string Database::wal_seq_path() const { return dir_ + "/WAL.SEQ"; }

uint32_t Database::next_wal_seg_id() {
  bool any = false;
  uint32_t max_id = 0;
  const auto note = [&](unsigned long value) {
    if (!any || value > max_id) max_id = static_cast<uint32_t>(value);
    any = true;
  };
  std::error_code ec;
  if (file_exists(wal_seq_path())) {
    try {
      const Bytes text = read_file(wal_seq_path());
      char* end = nullptr;
      const unsigned long value = std::strtoul(text.c_str(), &end, 10);
      if (end != nullptr && *end == '\0') note(value);
    } catch (const std::exception&) {
      // A damaged sidecar only skips a few ids.
    }
  }
  std::filesystem::directory_iterator it(fs_path_from_utf8(dir_), ec);
  if (!ec) {
    for (; it != std::filesystem::directory_iterator(); it.increment(ec)) {
      if (ec) break;
      const std::string name = it->path().filename().string();
      if (!starts_with(name, "wal-") || name.size() < 10 ||
          name.compare(name.size() - 4, 4, ".log") != 0) {
        continue;
      }
      const std::string digits = name.substr(4, name.size() - 8);
      char* end = nullptr;
      const unsigned long value = std::strtoul(digits.c_str(), &end, 10);
      if (digits.empty() || end == nullptr || *end != '\0') continue;
      note(value);
    }
  }
  const uint32_t next = any ? max_id + 1 : 1;
  write_file_atomic(wal_seq_path(), bytes_span(std::to_string(next)));
  return next;
}

// ---------------------------------------------------------------- WAL

void Database::begin()
 {
  if (tx_active_) throw std::runtime_error("transaction already active");
  if (!pager_) throw std::runtime_error("database is not open");
  // Serialize writers across processes and observe everything committed so far.
  lock_ = std::make_unique<FileLock>(FileLock::acquire_wait(dir_ + "/locked"));
  try {
    pager_->refresh_from_disk();
    load_catalog();
    const uint32_t seg = next_wal_seg_id();
    wal_ = std::make_unique<WalWriter>(dir_, seg, 0);
    wal_->append(WalRecordType::Begin, {});
  } catch (...) {
    wal_.reset();
    lock_.reset();
    throw;
  }
  pager_->begin_write_txn();
  tx_active_ = true;
}

void Database::commit() {
  if (!tx_active_) throw std::runtime_error("no active transaction");
  const auto sealed = pager_->seal_dirty_pages();
  for (const auto& [ref, slot] : sealed) {
    Bytes payload;
    append_u32_le(payload, ref.seg);
    append_u32_le(payload, ref.page);
    append_u32_le(payload, ref.generation);
    payload.append(slot);
    wal_->append(WalRecordType::Page, bytes_span(payload));
  }
  wal_->append(WalRecordType::Commit, {});
  wal_->sync();
  // Publish the committed pages before dropping the lock so that other
  // processes and future opens observe them immediately.
  pager_->flush();
  pager_->sync();
  pager_->commit_write_txn();
  tx_active_ = false;
  wal_.reset();
  try {
    ensure_wal_size_ok();
  } catch (...) {
    // Committed data is safely in the WAL and in the page files; a later
    // checkpoint can retry.
  }
  lock_.reset();
}

void Database::rollback() {
  if (!tx_active_) return;
  try {
    wal_->append(WalRecordType::Rollback, {});
    wal_->sync();
  } catch (...) {
    // The uncommitted transaction is dropped on recovery anyway.
  }
  // Restore the page images snapshotted on first modification; committed pages
  // that were still cache-only survive (they are part of the baseline). The
  // restored images are committed state, so publish them before leaving.
  pager_->rollback_write_txn();
  pager_->flush();
  pager_->sync();
  tx_active_ = false;
  wal_.reset();
  try {
    load_catalog();
  } catch (...) {
    // Keep the previous catalog view if it cannot be reloaded.
  }
  lock_.reset();
}

void Database::recover() {
  const std::vector<WalRecord> records =
      WalReader::read_all(dir_, /*tolerate_tail=*/true);
  bool in_txn = false;
  std::vector<Bytes> page_records;
  for (const WalRecord& record : records) {
    switch (record.type) {
      case WalRecordType::Begin:
        in_txn = true;
        page_records.clear();
        break;
      case WalRecordType::Page:
        if (in_txn) page_records.push_back(record.payload);
        break;
      case WalRecordType::Commit:
        if (in_txn) {
          for (const Bytes& payload : page_records) {
            if (payload.size() < 12) {
              throw std::runtime_error("wal: malformed page record");
            }
            const uint8_t* p = reinterpret_cast<const uint8_t*>(payload.data());
            const PageRef ref{load_u32_le(p), load_u32_le(p + 4),
                              load_u32_le(p + 8)};
            const ByteSpan slot(reinterpret_cast<const uint8_t*>(payload.data()) + 12,
                                payload.size() - 12);
            if (slot.size() != pager_->page_size()) {
              throw std::runtime_error("wal: page record has wrong slot size");
            }
            pager_->redo_raw_slot(ref, slot);
          }
        }
        in_txn = false;
        page_records.clear();
        break;
      case WalRecordType::Rollback:
        in_txn = false;
        page_records.clear();
        break;
    }
  }
  // Uncommitted trailing transaction is dropped by construction.
  pager_->flush();
  pager_->sync();
}

void Database::reset_wal_after_checkpoint() {
  pager_->flush();
  pager_->sync();
  ++wal_gen_;
  write_catalog();
  pager_->flush();
  pager_->sync();
  // Close the current writer before deleting its segment: Windows refuses to
  // remove a file that is still open. Between transactions there is no writer.
  wal_.reset();
  delete_wal_files();
}

void Database::delete_wal_files() {
  std::error_code ec;
  std::filesystem::directory_iterator it(fs_path_from_utf8(dir_), ec);
  if (ec) return;
  std::vector<std::string> victims;
  for (; it != std::filesystem::directory_iterator(); it.increment(ec)) {
    if (ec) break;
    const std::string name = it->path().filename().string();
    if (starts_with(name, "wal-") && name.size() > 4 &&
        name.compare(name.size() - 4, 4, ".log") == 0) {
      victims.push_back(dir_ + "/" + name);
    }
  }
  for (const std::string& path : victims) remove_file(path);
}

void Database::ensure_wal_size_ok() {
  std::error_code ec;
  std::filesystem::directory_iterator it(fs_path_from_utf8(dir_), ec);
  if (ec) return;
  uint64_t total = 0;
  for (; it != std::filesystem::directory_iterator(); it.increment(ec)) {
    if (ec) break;
    const std::string name = it->path().filename().string();
    if (!starts_with(name, "wal-") || name.size() < 8 ||
        name.compare(name.size() - 4, 4, ".log") != 0) {
      continue;
    }
    total += std::filesystem::file_size(it->path());
  }
  if (total <= kAutoCheckpointWalBytes) return;
  try {
    checkpoint();
  } catch (...) {
    // Committed data is safely in the WAL; a later checkpoint can retry.
  }
}

// ---------------------------------------------------------------- catalog

void Database::write_catalog() {
  const Bytes body = encode_catalog(wal_gen_, tables_, indexes_);
  catalog_ref_ = pager_->update_page(catalog_ref_, PageType::System, 0,
                                     bytes_span(body));
}

void Database::load_catalog() {
  catalog_ref_ = pager_->current_ref(0, 1);
  const Bytes& plain = pager_->read_page(catalog_ref_);
  PageHeader header;
  ByteSpan body;
  if (!decode_page(bytes_span(plain), header, body)) {
    throw std::runtime_error("catalog page is corrupt");
  }
  CatalogData data = decode_catalog(body);
  wal_gen_ = data.wal_gen;
  tables_ = std::move(data.tables);
  indexes_ = std::move(data.indexes);
}

bool Database::table_exists(const std::string& name) const {
  return tables_.find(name) != tables_.end();
}

const TableInfo& Database::table_info(const std::string& name) const {
  const auto it = tables_.find(name);
  if (it == tables_.end()) throw std::runtime_error("no such table: " + name);
  return it->second;
}

std::vector<std::string> Database::table_names() const {
  std::vector<std::string> names;
  names.reserve(tables_.size());
  for (const auto& [name, info] : tables_) {
    (void)info;
    names.push_back(name);
  }
  return names;
}

void Database::create_table(const TableSchema& schema) {
  validate_schema(schema);
  auto_txn(*this, [&] {
    if (tables_.find(schema.name) != tables_.end()) {
      throw std::runtime_error("table already exists: " + schema.name);
    }
    const PageRef root = HeapTable::create(*pager_);
    TableInfo info;
    info.schema = schema;
    info.root_seg = root.seg;
    info.root_page = root.page;
    tables_.emplace(schema.name, std::move(info));
    write_catalog();
  });
}

void Database::drop_table(const std::string& name) {
  auto_txn(*this, [&] {
    if (tables_.erase(name) == 0) {
      throw std::runtime_error("no such table: " + name);
    }
    // Indexes belong to their table: dropping the table drops them too.
    const std::string lower = to_lower_ascii(name);
    for (auto it = indexes_.begin(); it != indexes_.end();) {
      if (it->second.table == lower) {
        it = indexes_.erase(it);
      } else {
        ++it;
      }
    }
    write_catalog();
  });
}

// ---------------------------------------------------------------- rows

HeapTable Database::heap_for(const TableInfo& info) {
  return HeapTable(*pager_, pager_->current_ref(info.root_seg, info.root_page));
}

Rid Database::insert_row(const std::string& table, const Row& row) {
  return auto_txn(*this, [&] {
    const TableInfo& info = table_info(table);
    const Bytes record = encode_row(info.schema, row);
    HeapTable heap = heap_for(info);
    const Rid rid = heap.insert(bytes_span(record));
    if (index_insert_row(info, row, rid)) write_catalog();
    return rid;
  });
}

std::vector<std::pair<Rid, Row>> Database::scan_rows(const std::string& table) {
  const TableInfo& info = table_info(table);
  HeapTable heap = heap_for(info);
  std::vector<std::pair<Rid, Row>> rows;
  for (const Rid& rid : heap.scan()) {
    rows.emplace_back(rid, decode_row(info.schema, bytes_span(heap.get(rid))));
  }
  return rows;
}

Row Database::get_row(const std::string& table, Rid rid) {
  const TableInfo& info = table_info(table);
  HeapTable heap = heap_for(info);
  return decode_row(info.schema, bytes_span(heap.get(rid)));
}

Rid Database::update_row(const std::string& table, Rid rid, const Row& row) {
  return auto_txn(*this, [&] {
    const TableInfo& info = table_info(table);
    const Bytes record = encode_row(info.schema, row);
    Row old;
    {
      HeapTable heap = heap_for(info);
      old = decode_row(info.schema, bytes_span(heap.get(rid)));
      if (!heap.remove(rid)) throw std::runtime_error("row not found");
    }
    HeapTable heap = heap_for(info);
    const Rid moved = heap.insert(bytes_span(record));
    // The row moved to a new rid: drop the old index entries and add ones for
    // the new position, even when the indexed column did not change.
    bool changed = index_delete_row(info, old, rid);
    changed = index_insert_row(info, row, moved) || changed;
    if (changed) write_catalog();
    return moved;
  });
}

void Database::delete_row(const std::string& table, Rid rid) {
  auto_txn(*this, [&] {
    const TableInfo& info = table_info(table);
    Row old;
    {
      HeapTable heap = heap_for(info);
      old = decode_row(info.schema, bytes_span(heap.get(rid)));
      if (!heap.remove(rid)) throw std::runtime_error("row not found");
    }
    if (index_delete_row(info, old, rid)) write_catalog();
  });
}

// ---------------------------------------------------------------- indexes

bool Database::index_insert_row(const TableInfo& info, const Row& row,
                                Rid rid) {
  const std::string table_name = to_lower_ascii(info.schema.name);
  bool changed = false;
  for (auto& [name, index] : indexes_) {
    (void)name;
    if (index.table != table_name) continue;
    const int column_pos = find_column(info.schema, index.column);
    if (column_pos < 0) continue;
    const Value& value = row.values[static_cast<std::size_t>(column_pos)];
    if (value.type == ValueType::Null) continue;
    FixedBTree tree(*pager_,
                    pager_->current_ref(index.root_seg, index.root_page));
    const IndexKey key = encode_index_key(value, rid);
    tree.insert(ByteSpan(key.data(), key.size()), rid);
    const PageRef root = tree.root();
    index.root_seg = root.seg;
    index.root_page = root.page;
    changed = true;
  }
  return changed;
}

bool Database::index_delete_row(const TableInfo& info, const Row& row,
                                Rid rid) {
  const std::string table_name = to_lower_ascii(info.schema.name);
  bool changed = false;
  for (auto& [name, index] : indexes_) {
    (void)name;
    if (index.table != table_name) continue;
    const int column_pos = find_column(info.schema, index.column);
    if (column_pos < 0) continue;
    const Value& value = row.values[static_cast<std::size_t>(column_pos)];
    if (value.type == ValueType::Null) continue;
    FixedBTree tree(*pager_,
                    pager_->current_ref(index.root_seg, index.root_page));
    const IndexKey key = encode_index_key(value, rid);
    tree.remove(ByteSpan(key.data(), key.size()));
    const PageRef root = tree.root();
    index.root_seg = root.seg;
    index.root_page = root.page;
    changed = true;
  }
  return changed;
}

void Database::create_index(const std::string& name, const std::string& table,
                            const std::string& column) {
  const std::string index_name = to_lower_ascii(name);
  if (index_name.empty()) throw std::runtime_error("index name is empty");
  const std::string table_name = to_lower_ascii(table);
  auto_txn(*this, [&] {
    if (indexes_.find(index_name) != indexes_.end()) {
      throw std::runtime_error("index already exists: " + index_name);
    }
    const TableInfo& info = table_info(table_name);
    const int column_pos = find_column(info.schema, column);
    if (column_pos < 0) {
      throw std::runtime_error("no such column: " + table_name + "." + column);
    }
    const ColumnDef& def =
        info.schema.columns[static_cast<std::size_t>(column_pos)];
    IndexInfo index;
    index.name = index_name;
    index.table = table_name;
    index.column = def.name;
    index.type = def.type;
    // Build from the rows already stored, so an index created after INSERTs is
    // immediately complete.
    FixedBTree tree = FixedBTree::create(*pager_);
    HeapTable heap = heap_for(info);
    for (const Rid& rid : heap.scan()) {
      const Row row = decode_row(info.schema, bytes_span(heap.get(rid)));
      const Value& value = row.values[static_cast<std::size_t>(column_pos)];
      if (value.type == ValueType::Null) continue;
      const IndexKey key = encode_index_key(value, rid);
      tree.insert(ByteSpan(key.data(), key.size()), rid);
    }
    const PageRef root = tree.root();
    index.root_seg = root.seg;
    index.root_page = root.page;
    indexes_.emplace(index_name, std::move(index));
    write_catalog();
  });
}

void Database::drop_index(const std::string& name) {
  const std::string index_name = to_lower_ascii(name);
  auto_txn(*this, [&] {
    if (indexes_.erase(index_name) == 0) {
      throw std::runtime_error("no such index: " + index_name);
    }
    write_catalog();
  });
}

bool Database::index_exists(const std::string& name) const {
  return indexes_.find(to_lower_ascii(name)) != indexes_.end();
}

std::vector<std::string> Database::index_names() const {
  std::vector<std::string> names;
  names.reserve(indexes_.size());
  for (const auto& [name, index] : indexes_) {
    (void)index;
    names.push_back(name);
  }
  return names;
}

const IndexInfo* Database::find_index(const std::string& table,
                                      const std::string& column) const {
  const std::string table_key = to_lower_ascii(table);
  const std::string column_key = to_lower_ascii(column);
  for (const auto& [name, index] : indexes_) {
    (void)name;
    if (index.table == table_key &&
        to_lower_ascii(index.column) == column_key) {
      return &index;
    }
  }
  return nullptr;
}

}  // namespace iaqs::db
