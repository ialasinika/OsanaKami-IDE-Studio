// Database-backed content-addressed object store.
//
// Physical shapes (design 01 §6 / 02):
//   storage 0: inline raw payload
//   storage 1: inline LZ1(payload)
//   storage 2: inline IAQSD1 delta against base_oid   (gc layer, later)
//   storage 3: chunked payload. Fresh writes use a hierarchical chunk tree:
//              objects.payload = [u8 levels][32-byte root directory id].
//              A directory node (chunk_dirs table) holds up to 128 child ids,
//              level 1 children are data chunks (chunks table), higher levels
//              are directory nodes. With 4 KiB data chunks and a 128-way
//              fan-out this keeps roughly 4 levels for a 1 TiB blob and never
//              needs the full chunk list in memory. Legacy flat chunk lists
//              (payload length multiple of 32) stay readable.
#pragma once

#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

#include "core/util.h"
#include "db/btree.h"
#include "db/database.h"
#include "vcs/objects.h"

namespace iaqs::vcs {

class ObjectStore {
 public:
  explicit ObjectStore(db::Database& database) : db_(database) {}

  // Creates the objects/chunks/chunk_dirs tables when missing (idempotent).
  void ensure_schema();

  // Writes payload (content addressing, idempotent) and returns the oid.
  std::string write(ObjType type, std::string_view payload);

  // Streaming write. `size` is the payload size and must be known in advance
  // (the object id frame contains it). `reader` fills up to `capacity` bytes
  // and returns the number of bytes produced; 0 means end of payload.
  using StreamReader = std::function<size_t(uint8_t* buffer, size_t capacity)>;
  std::string write_stream(ObjType type, uint64_t size, const StreamReader& reader);

  bool has(std::string_view oid);
  ObjType type_of(std::string_view oid);

  // Reads and verifies payload against its oid. Throws std::runtime_error when
  // the object is missing or corrupt. For large chunked objects prefer
  // read_stream/write_to_file, which never hold the whole payload in memory.
  std::string read(std::string_view oid, ObjType* type = nullptr);

  // Streaming read: `sink` receives successive payload slices in order.
  using StreamSink = std::function<void(ByteSpan)>;
  void read_stream(std::string_view oid, const StreamSink& sink, ObjType* type = nullptr);

  // Writes the object payload to a file through the streaming path.
  void write_to_file(std::string_view oid, const std::filesystem::path& path);

  // Metadata for maintenance passes (gc/fsck); does not load payloads.
  struct StoredObject {
    std::string oid;
    ObjType type = ObjType::Blob;
    int64_t raw_size = 0;
    int64_t storage = 0;
    std::string base_oid;
    // objects.created_ts: write time in unix seconds. Incremental gc uses it to
    // bound its candidate set (see Repo::gc).
    int64_t created_ts = 0;
    // Size of the stored payload column, i.e. the same value stored_bytes(oid)
    // returns. Snapshotted here so a full table scan can accumulate totals in
    // one pass instead of one meta lookup per object.
    int64_t stored_bytes = 0;
  };
  std::vector<StoredObject> list_objects();

  // Bytes currently occupied by the stored payload of `oid` (chunk lists count
  // as their id bytes; shared chunk bytes are not double counted here).
  int64_t stored_bytes(std::string_view oid);

  // Rewrites an existing object as an IAQSD1 delta against `base_oid`.
  // `raw_size` is the size of the reconstructed payload.
  void store_delta(std::string_view oid, std::string_view base_oid,
                   std::string_view delta, int64_t raw_size);

  // Drops an object row (and, when no other object references them, chunks).
  void remove(std::string_view oid);

  // Convenience: encode payload of `type` and verify it decodes as that type.
  db::Database& database() { return db_; }

  // Inline payload limit derived from the page size (records must fit one page).
  size_t inline_limit() const;

  // Raw bytes per data chunk (before compression).
  static constexpr size_t chunk_raw_size() { return 4096; }
  // Maximum number of child ids in one directory node (32 bytes each).
  static constexpr size_t dir_fanout() { return chunk_raw_size() / 32; }

 private:
  struct Meta {
    ObjType type = ObjType::Blob;
    int64_t raw_size = 0;
    int64_t storage = 0;
    std::string base_oid;
    std::string payload;  // inline bytes, chunk id list or chunk-tree header
  };

  std::optional<Meta> load_meta(std::string_view oid);
  std::string read_at(std::string_view oid, ObjType* type, int depth);

  // Loads a data chunk (decompressing as needed) and verifies its id.
  Bytes load_data_chunk(const std::string& chunk_oid);
  // Loads/creates a directory node; the node id is the sha256 of its payload.
  Bytes load_dir_node(const std::string& dir_oid);
  std::string store_data_chunk(ByteSpan data);
  std::string store_dir_node(ByteSpan payload);
  // Emits data chunks referenced by a subtree (levels: dir levels above data).
  void walk_chunk_tree(const std::string& node_oid, int levels, const StreamSink& sink);
  // Collects data chunk ids and directory ids referenced by a chunked object.
  void collect_chunk_tree(const std::string& root_oid, int levels,
                          std::vector<std::string>* data_ids,
                          std::vector<std::string>* dir_ids);
  void ensure_chunk_index();
  void rebuild_chunk_index();

  // B+tree indexes over chunks(chunk_oid) and chunk_dirs(dir_oid), keyed by the
  // raw 32-byte digest so reads no longer scan the whole table.
  void ensure_indexes();
  void persist_index_roots();
  void index_put(bool is_dir, const std::string& hex_id, const db::Rid& rid);
  void index_erase(bool is_dir, const std::string& hex_id);
  std::optional<db::Rid> index_find(bool is_dir, const std::string& hex_id);
  // Fallback lookup used to repair a missing/stale index entry.
  std::optional<db::Rid> scan_for_id(const std::string& table,
                                     const std::string& hex_id);

  db::Database& db_;
  bool chunk_index_loaded_ = false;
  std::unordered_set<std::string> chunk_ids_;
  std::unordered_set<std::string> dir_ids_;
  std::unique_ptr<db::FixedBTree> data_btree_;
  std::unique_ptr<db::FixedBTree> dir_btree_;
};

}  // namespace iaqs::vcs
