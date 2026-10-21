// Encrypted relational database: MANIFEST + key ring + paged storage (segments,
// page cache, WAL). This is the storage engine the version manager sits on.
#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "core/lock.h"
#include "core/util.h"
#include "db/heap.h"
#include "db/index.h"
#include "db/keys.h"
#include "db/manifest.h"
#include "db/page.h"
#include "db/pager.h"
#include "db/row.h"
#include "db/wal.h"

namespace iaqs::db {

// Catalog entry: table schema plus the address of its heap root page.
struct TableInfo {
  TableSchema schema;
  uint32_t root_seg = 0;
  uint32_t root_page = 0;
  PageRef root_ref() const { return PageRef{root_seg, root_page, 0}; }
};

// A multi-process safe embedded database.
//
// Concurrency model: write transactions from different processes are
// serialized by a cross-process lock file (<dir>/locked), which is held from
// begin() to commit()/rollback(). Before each transaction starts, cached pages
// and the catalog are refreshed from disk so the transaction observes the
// latest committed state. Committed pages are flushed before the lock is
// released, so other processes (and later opens) see them immediately.
// Read-only use after open() sees the state committed at open time.
//
// Durability model: every committed transaction is a sequence of WAL records
// (Begin, Page*, Commit) fsynced before commit returns; pages are then flushed
// to the segment files. Opening a database replays committed WAL transactions
// into the page files before returning.
class Database {
 public:
  static Database create(const std::string& dir, std::string_view password,
                         uint32_t page_size = kDefaultPageSize);
  static Database open(const std::string& dir, std::string_view password);

  Database() = default;
  ~Database();
  Database(Database&&) noexcept = default;
  Database& operator=(Database&&) noexcept = default;
  Database(const Database&) = delete;
  Database& operator=(const Database&) = delete;

  // Flushes dirty pages, fsyncs segments and rotates the WAL.
  void checkpoint();

  // checkpoint() + wipes keys.
  void close();

  // Re-wraps the data encryption key under `new_password` (fresh salt and
  // nonces); the encrypted pages and WAL stay byte-identical. The change is
  // persisted immediately.
  void change_password(std::string_view new_password);

  // Replaces the data encryption key and re-encrypts every page in place.
  // Crash-safe: the new DEK is first persisted in a wrapped sidecar file, and
  // an interrupted rekey is resumed by the next open(). `progress(done, total)`
  // reports re-encrypted pages and may be empty.
  void rekey_data(const Pager::RekeyProgress& progress = {});

  // Explicit transactions (row/DDL helpers auto-commit when none is active).
  void begin();
  void commit();
  void rollback();
  bool in_transaction() const { return tx_active_; }

  // Catalog.
  bool table_exists(const std::string& name) const;
  const TableInfo& table_info(const std::string& name) const;
  std::vector<std::string> table_names() const;
  void create_table(const TableSchema& schema);
  void drop_table(const std::string& name);

  // Rows (auto-commit when no transaction is active).
  Rid insert_row(const std::string& table, const Row& row);
  std::vector<std::pair<Rid, Row>> scan_rows(const std::string& table);
  Row get_row(const std::string& table, Rid rid);
  Rid update_row(const std::string& table, Rid rid, const Row& row);
  void delete_row(const std::string& table, Rid rid);

  // Secondary indexes (auto-commit when no transaction is active). Names and
  // table names are case-insensitive; `column` must name a column of `table`.
  // CREATE INDEX builds the tree from the rows already stored, so an index over
  // an existing table is immediately complete; later row writes maintain it.
  void create_index(const std::string& name, const std::string& table,
                    const std::string& column);
  void drop_index(const std::string& name);
  bool index_exists(const std::string& name) const;
  std::vector<std::string> index_names() const;  // lower-case, sorted
  // The index over `table`(`column`), or nullptr. Matching is case-insensitive;
  // the lexicographically smallest index name wins when several exist.
  const IndexInfo* find_index(const std::string& table,
                              const std::string& column) const;

  Pager& pager() { return *pager_; }
  const Manifest& manifest() const { return manifest_; }

  // False for the plaintext store this project creates (no password, no key).
  bool encrypted() const { return encrypted_; }
  uint32_t epoch() const { return epoch_; }
  uint32_t wal_generation() const { return wal_gen_; }

 private:
  void initialize_common(const std::string& dir, Manifest manifest,
                         DbKeys keys);
  void recover();
  void reset_wal_after_checkpoint();
  void delete_wal_files();
  void write_catalog();
  void load_catalog();
  HeapTable heap_for(const TableInfo& info);
  void ensure_wal_size_ok();

  // Concurrency: lock_ is held for the duration of a write transaction or an
  // exclusive maintenance operation (checkpoint, password change, rekey).
  // acquire_write_lock() returns true when this call actually acquired it.
  bool acquire_write_lock(const std::string& dir = "");
  void release_write_lock(bool acquired);
  uint32_t next_wal_seg_id();
  std::string wal_seq_path() const;

  // Secondary index maintenance. Each returns true when at least one index
  // entry or index root changed (the caller then rewrites the catalog).
  bool index_insert_row(const TableInfo& info, const Row& row, Rid rid);
  bool index_delete_row(const TableInfo& info, const Row& row, Rid rid);

  // rekey --data support.
  std::string rekey_state_path() const;
  void write_rekey_state(const Key32& dek);
  Key32 read_rekey_state() const;
  void finish_pending_rekey();

  std::string dir_;
  Manifest manifest_;
  DbKeys keys_;
  std::unique_ptr<Keyring> keyring_;
  bool encrypted_ = false;
  uint32_t epoch_ = 0;
  std::unique_ptr<Pager> pager_;
  // WAL writer for the active transaction only; null between transactions.
  std::unique_ptr<WalWriter> wal_;
  // Cross-process lock, held only while a write transaction or exclusive
  // maintenance operation is in progress.
  std::unique_ptr<FileLock> lock_;
  uint32_t wal_gen_ = 0;
  bool tx_active_ = false;
  std::map<std::string, TableInfo> tables_;
  std::map<std::string, IndexInfo> indexes_;
  PageRef catalog_ref_{};
};

}  // namespace iaqs::db
