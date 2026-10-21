#include "vcs/store.h"

#include <algorithm>
#include <cstring>
#include <ctime>
#include <fstream>
#include <stdexcept>
#include <unordered_map>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include "crypto/sha256.h"
#include "lz/delta.h"
#include "lz/lz1.h"

namespace iaqs::vcs {
namespace {

using db::ColumnDef;
using db::Row;
using db::TableSchema;
using db::Value;
using db::ValueType;

TableSchema objects_schema() {
  TableSchema schema;
  schema.name = "objects";
  schema.columns = {
      ColumnDef{"oid", ValueType::Text, true, true},
      ColumnDef{"type", ValueType::Integer, false, true},
      ColumnDef{"raw_size", ValueType::Integer, false, true},
      ColumnDef{"storage", ValueType::Integer, false, true},
      ColumnDef{"base_oid", ValueType::Text, false, false},
      ColumnDef{"payload", ValueType::Blob, false, false},
      ColumnDef{"lob_id", ValueType::Integer, false, false},
      ColumnDef{"created_ts", ValueType::Integer, false, true},
  };
  return schema;
}

TableSchema chunks_schema() {
  TableSchema schema;
  schema.name = "chunks";
  schema.columns = {
      ColumnDef{"chunk_oid", ValueType::Text, true, true},
      ColumnDef{"data", ValueType::Blob, false, true},
  };
  return schema;
}

TableSchema chunk_dirs_schema() {
  TableSchema schema;
  schema.name = "chunk_dirs";
  schema.columns = {
      ColumnDef{"dir_oid", ValueType::Text, true, true},
      ColumnDef{"payload", ValueType::Blob, false, true},
  };
  return schema;
}

// Two rows (kind = "data" | "dir") point at the B+tree root pages used to find
// chunks/chunk_dirs rows by digest without scanning the whole table.
TableSchema chunk_index_schema() {
  TableSchema schema;
  schema.name = "chunk_index";
  schema.columns = {
      ColumnDef{"kind", ValueType::Text, true, true},
      ColumnDef{"root_seg", ValueType::Integer, false, true},
      ColumnDef{"root_page", ValueType::Integer, false, true},
  };
  return schema;
}

[[noreturn]] void fail(const std::string& what) {
  throw std::runtime_error("object store: " + what);
}

std::string chunk_oid_of(ByteSpan data) { return sha256_hex(data); }

std::string u8(const std::filesystem::path& path) {
  const std::u8string s = path.u8string();
  return std::string(reinterpret_cast<const char*>(s.data()), s.size());
}

std::string hex_id_at(std::string_view ids, size_t index) {
  return to_hex(ByteSpan(reinterpret_cast<const uint8_t*>(ids.data()) + index * 32, 32));
}

Bytes id_bytes(const std::string& hex) {
  Bytes raw;
  if (!from_hex(hex, raw) || raw.size() != 32) fail("bad chunk id " + hex);
  return raw;
}

uint8_t storage_of(const Row& row) {
  return row.values.size() > 3 ? static_cast<uint8_t>(row.values[3].int_value) : 0;
}

bool is_chunked_row(const Row& row) {
  return storage_of(row) == 3 && row.values.size() > 5 &&
         row.values[5].type == ValueType::Blob;
}

std::string row_text(const Row& row, size_t index) {
  if (row.values.size() <= index || row.values[index].type != ValueType::Text) return {};
  return row.values[index].bytes;
}

}  // namespace

void ObjectStore::ensure_schema() {
  if (!db_.table_exists("objects")) db_.create_table(objects_schema());
  if (!db_.table_exists("chunks")) db_.create_table(chunks_schema());
  if (!db_.table_exists("chunk_dirs")) db_.create_table(chunk_dirs_schema());
  if (!db_.table_exists("chunk_index")) db_.create_table(chunk_index_schema());
  ensure_indexes();
}

void ObjectStore::ensure_indexes() {
  if (data_btree_ && dir_btree_) return;
  db::Pager& pager = db_.pager();
  std::optional<db::PageRef> data_root;
  std::optional<db::PageRef> dir_root;
  for (const auto& [rid, row] : db_.scan_rows("chunk_index")) {
    (void)rid;
    if (row.values.size() < 3) continue;
    const std::string kind = row_text(row, 0);
    const uint32_t seg = static_cast<uint32_t>(row.values[1].int_value);
    const uint32_t page = static_cast<uint32_t>(row.values[2].int_value);
    if (kind == "data") data_root = pager.current_ref(seg, page);
    if (kind == "dir") dir_root = pager.current_ref(seg, page);
  }
  const bool need_data_rebuild = !data_root;
  const bool need_dir_rebuild = !dir_root;
  data_btree_ = std::make_unique<db::FixedBTree>(
      data_root ? db::FixedBTree(pager, *data_root) : db::FixedBTree::create(pager));
  dir_btree_ = std::make_unique<db::FixedBTree>(
      dir_root ? db::FixedBTree(pager, *dir_root) : db::FixedBTree::create(pager));
  if (!need_data_rebuild && !need_dir_rebuild) {
    persist_index_roots();
    return;
  }
  // Migration/repair: build fresh trees from the current tables.
  for (const auto& [rid, row] : db_.scan_rows("chunks")) {
    const std::string id = row_text(row, 0);
    if (!id.empty()) data_btree_->insert(bytes_span(id_bytes(id)), rid);
  }
  for (const auto& [rid, row] : db_.scan_rows("chunk_dirs")) {
    const std::string id = row_text(row, 0);
    if (!id.empty()) dir_btree_->insert(bytes_span(id_bytes(id)), rid);
  }
  persist_index_roots();
}

void ObjectStore::persist_index_roots() {
  auto upsert = [&](const std::string& kind, const db::PageRef& root) {
    for (const auto& [rid, row] : db_.scan_rows("chunk_index")) {
      if (row.values.size() >= 1 && row.values[0].type == ValueType::Text &&
          row.values[0].bytes == kind) {
        Row next;
        next.values = {Value::text(Bytes(kind)), Value::integer(root.seg),
                       Value::integer(root.page)};
        db_.update_row("chunk_index", rid, next);
        return;
      }
    }
    Row row;
    row.values = {Value::text(Bytes(kind)), Value::integer(root.seg),
                  Value::integer(root.page)};
    db_.insert_row("chunk_index", row);
  };
  upsert("data", data_btree_->root());
  upsert("dir", dir_btree_->root());
}

void ObjectStore::index_put(bool is_dir, const std::string& hex_id, const db::Rid& rid) {
  ensure_indexes();
  Bytes key = id_bytes(hex_id);
  (is_dir ? dir_btree_ : data_btree_)->insert(bytes_span(key), rid);
  persist_index_roots();
}

void ObjectStore::index_erase(bool is_dir, const std::string& hex_id) {
  ensure_indexes();
  Bytes key = id_bytes(hex_id);
  (is_dir ? dir_btree_ : data_btree_)->remove(bytes_span(key));
  persist_index_roots();
}

std::optional<db::Rid> ObjectStore::index_find(bool is_dir, const std::string& hex_id) {
  ensure_indexes();
  Bytes key = id_bytes(hex_id);
  return (is_dir ? dir_btree_ : data_btree_)->find(bytes_span(key));
}

std::optional<db::Rid> ObjectStore::scan_for_id(const std::string& table,
                                                const std::string& hex_id) {
  for (const auto& [rid, row] : db_.scan_rows(table)) {
    if (row_text(row, 0) == hex_id) return rid;
  }
  return std::nullopt;
}

size_t ObjectStore::inline_limit() const {
  const uint64_t page_size = db_.manifest().page_size;
  if (page_size <= 2048) return 1024;
  return static_cast<size_t>(page_size - 2048);
}

std::optional<ObjectStore::Meta> ObjectStore::load_meta(std::string_view oid) {
  for (const auto& [rid, row] : db_.scan_rows("objects")) {
    if (row_text(row, 0) != std::string(oid)) continue;
    Meta meta;
    meta.type = static_cast<ObjType>(row.values[1].int_value);
    meta.raw_size = row.values[2].int_value;
    meta.storage = row.values[3].int_value;
    if (row.values.size() > 4 && row.values[4].type == ValueType::Text) {
      meta.base_oid = row.values[4].bytes;
    }
    if (row.values.size() > 5 && row.values[5].type == ValueType::Blob) {
      meta.payload = row.values[5].bytes;
    }
    return meta;
  }
  return std::nullopt;
}

bool ObjectStore::has(std::string_view oid) { return load_meta(oid).has_value(); }

ObjType ObjectStore::type_of(std::string_view oid) {
  const auto meta = load_meta(oid);
  if (!meta) fail("unknown object " + std::string(oid));
  return meta->type;
}

void ObjectStore::ensure_chunk_index() {
  if (chunk_index_loaded_) return;
  rebuild_chunk_index();
}

void ObjectStore::rebuild_chunk_index() {
  chunk_ids_.clear();
  dir_ids_.clear();
  for (const auto& [rid, row] : db_.scan_rows("chunks")) {
    if (row.values.empty()) continue;
    const std::string id = row_text(row, 0);
    if (!id.empty()) chunk_ids_.insert(id);
  }
  for (const auto& [rid, row] : db_.scan_rows("chunk_dirs")) {
    if (row.values.empty()) continue;
    const std::string id = row_text(row, 0);
    if (!id.empty()) dir_ids_.insert(id);
  }
  chunk_index_loaded_ = true;
}

std::string ObjectStore::store_data_chunk(ByteSpan data) {
  const std::string cid = chunk_oid_of(data);
  ensure_chunk_index();
  if (chunk_ids_.find(cid) != chunk_ids_.end()) return cid;

  Bytes packed = lz::lz1_compress(data);
  if (packed.size() + 16 >= data.size()) packed.assign(data.begin(), data.end());
  Row row;
  row.values = {Value::text(Bytes(cid)), Value::blob(std::move(packed))};
  const db::Rid rid = db_.insert_row("chunks", row);
  chunk_ids_.insert(cid);
  index_put(false, cid, rid);
  return cid;
}

std::string ObjectStore::store_dir_node(ByteSpan payload) {
  const std::string did = chunk_oid_of(payload);
  ensure_chunk_index();
  if (dir_ids_.find(did) != dir_ids_.end()) return did;
  Row row;
  row.values = {Value::text(Bytes(did)), Value::blob(Bytes(payload.begin(), payload.end()))};
  const db::Rid rid = db_.insert_row("chunk_dirs", row);
  dir_ids_.insert(did);
  index_put(true, did, rid);
  return did;
}

Bytes ObjectStore::load_data_chunk(const std::string& chunk_oid) {
  std::optional<db::Rid> rid = index_find(false, chunk_oid);
  if (!rid) {
    rid = scan_for_id("chunks", chunk_oid);
    if (!rid) fail("missing chunk " + chunk_oid);
    index_put(false, chunk_oid, *rid);  // repair a missing index entry
  }
  const Row row = db_.get_row("chunks", *rid);
  if (row.values.size() < 2 || row.values[1].type != ValueType::Blob) {
    fail("corrupt chunk " + chunk_oid);
  }
  Bytes data = row.values[1].bytes;
  if (lz::lz1_is_compressed(bytes_span(data))) data = lz::lz1_decompress(bytes_span(data));
  if (chunk_oid_of(bytes_span(data)) != chunk_oid) fail("chunk hash mismatch for " + chunk_oid);
  return data;
}

Bytes ObjectStore::load_dir_node(const std::string& dir_oid) {
  std::optional<db::Rid> rid = index_find(true, dir_oid);
  if (!rid) {
    rid = scan_for_id("chunk_dirs", dir_oid);
    if (!rid) fail("missing directory node " + dir_oid);
    index_put(true, dir_oid, *rid);
  }
  const Row row = db_.get_row("chunk_dirs", *rid);
  if (row.values.size() < 2 || row.values[1].type != ValueType::Blob) {
    fail("corrupt directory node " + dir_oid);
  }
  Bytes payload = row.values[1].bytes;
  if (chunk_oid_of(bytes_span(payload)) != dir_oid) {
    fail("directory hash mismatch for " + dir_oid);
  }
  return payload;
}

std::string ObjectStore::write(ObjType type, std::string_view payload) {
  if (payload.size() <= inline_limit()) {
    const std::string oid = object_id(type, payload);
    if (has(oid)) return oid;

    std::string stored;
    int64_t storage = 0;
    Bytes compressed = lz::lz1_compress(bytes_span(payload));
    if (compressed.size() + 16 < payload.size()) {
      stored = compressed;
      storage = 1;
    } else {
      stored = std::string(payload);
      storage = 0;
    }
    Row row;
    row.values = {
        Value::text(Bytes(oid)),
        Value::integer(static_cast<int64_t>(type)),
        Value::integer(static_cast<int64_t>(payload.size())),
        Value::integer(storage),
        Value::null(),
        Value::blob(Bytes(stored)),
        Value::integer(0),
        Value::integer(static_cast<int64_t>(std::time(nullptr))),
    };
    db_.insert_row("objects", row);
    return oid;
  }

  const std::string_view view(payload);
  size_t offset = 0;
  return write_stream(type, payload.size(), [&](uint8_t* buffer, size_t capacity) -> size_t {
    const size_t remaining = view.size() - offset;
    const size_t n = std::min(capacity, remaining);
    std::memcpy(buffer, view.data() + offset, n);
    offset += n;
    return n;
  });
}

std::string ObjectStore::write_stream(ObjType type, uint64_t size, const StreamReader& reader) {
  if (size <= inline_limit()) {
    Bytes payload;
    payload.resize(static_cast<size_t>(size));
    size_t got = 0;
    while (got < payload.size()) {
      const size_t n = reader(reinterpret_cast<uint8_t*>(payload.data()) + got, payload.size() - got);
      if (n == 0) fail("unexpected end of stream");
      got += n;
    }
    return write(type, std::string(payload));
  }

  std::string header(type_name(type));
  header += ' ';
  header += std::to_string(size);
  header += '\0';

  Sha256 hasher;
  hasher.update(header);

  std::vector<std::string> level_ids;
  Bytes buffer(chunk_raw_size(), '\0');
  uint64_t remaining = size;
  while (remaining > 0) {
    const size_t want = static_cast<size_t>(std::min<uint64_t>(remaining, chunk_raw_size()));
    size_t got = 0;
    while (got < want) {
      const size_t n = reader(reinterpret_cast<uint8_t*>(buffer.data()) + got, want - got);
      if (n == 0) fail("unexpected end of stream");
      got += n;
    }
    hasher.update(ByteSpan(reinterpret_cast<const uint8_t*>(buffer.data()), want));
    level_ids.push_back(store_data_chunk(ByteSpan(reinterpret_cast<const uint8_t*>(buffer.data()), want)));
    remaining -= want;
  }
  if (level_ids.empty()) fail("empty stream");

  int levels = 0;
  while (level_ids.size() > 1) {
    std::vector<std::string> next;
    for (size_t i = 0; i < level_ids.size(); i += dir_fanout()) {
      Bytes payload;
      const size_t end = std::min(i + dir_fanout(), level_ids.size());
      for (size_t j = i; j < end; ++j) {
        Bytes raw = id_bytes(level_ids[j]);
        payload.append(raw);
      }
      next.push_back(store_dir_node(bytes_span(payload)));
    }
    level_ids = std::move(next);
    ++levels;
  }

  const std::array<uint8_t, 32> digest = hasher.finish();
  const std::string oid = to_hex(ByteSpan(digest.data(), digest.size()));
  if (has(oid)) return oid;

  Bytes payload;
  payload.push_back(static_cast<uint8_t>(levels));
  Bytes root = id_bytes(level_ids.front());
  payload.append(root);

  Row row;
  row.values = {
      Value::text(Bytes(oid)),
      Value::integer(static_cast<int64_t>(type)),
      Value::integer(static_cast<int64_t>(size)),
      Value::integer(3),
      Value::null(),
      Value::blob(std::move(payload)),
      Value::integer(0),
      Value::integer(static_cast<int64_t>(std::time(nullptr))),
  };
  db_.insert_row("objects", row);
  return oid;
}

std::string ObjectStore::read(std::string_view oid, ObjType* type) {
  std::string payload;
  read_stream(oid, [&](ByteSpan slice) { payload.append(reinterpret_cast<const char*>(slice.data()), slice.size()); },
              type);
  return payload;
}

void ObjectStore::read_stream(std::string_view oid, const StreamSink& sink, ObjType* type) {
  const auto meta = load_meta(oid);
  if (!meta) fail("unknown object " + std::string(oid));
  if (type) *type = meta->type;

  std::string header(type_name(meta->type));
  header += ' ';
  header += std::to_string(meta->raw_size);
  header += '\0';
  Sha256 hasher;
  hasher.update(header);
  int64_t emitted = 0;
  auto emit = [&](ByteSpan slice) {
    hasher.update(slice);
    emitted += static_cast<int64_t>(slice.size());
    sink(slice);
  };

  switch (meta->storage) {
    case 0:
    case 1:
    case 2: {
      const std::string payload = read_at(oid, nullptr, 0);
      emit(ByteSpan(reinterpret_cast<const uint8_t*>(payload.data()), payload.size()));
      break;
    }
    case 3: {
      if (meta->payload.size() % 32 == 0 && meta->payload.size() != 33) {
        // Legacy flat chunk list.
        for (size_t i = 0; i < meta->payload.size() / 32; ++i) {
          const std::string cid = hex_id_at(meta->payload, i);
          const Bytes data = load_data_chunk(cid);
          emit(ByteSpan(reinterpret_cast<const uint8_t*>(data.data()), data.size()));
        }
      } else if (meta->payload.size() == 33) {
        const int levels = static_cast<uint8_t>(meta->payload[0]);
        const std::string root = to_hex(ByteSpan(
            reinterpret_cast<const uint8_t*>(meta->payload.data()) + 1, 32));
        walk_chunk_tree(root, levels, emit);
      } else {
        fail("corrupt chunk tree in object " + std::string(oid));
      }
      break;
    }
    default:
      fail("unsupported object storage " + std::to_string(meta->storage));
  }

  if (emitted != meta->raw_size) fail("size mismatch for object " + std::string(oid));
  const std::array<uint8_t, 32> digest = hasher.finish();
  if (to_hex(ByteSpan(digest.data(), digest.size())) != std::string(oid)) {
    fail("hash mismatch for object " + std::string(oid));
  }
}

void ObjectStore::walk_chunk_tree(const std::string& node_oid, int levels, const StreamSink& sink) {
  if (levels <= 0) {
    const Bytes data = load_data_chunk(node_oid);
    sink(ByteSpan(reinterpret_cast<const uint8_t*>(data.data()), data.size()));
    return;
  }
  const Bytes payload = load_dir_node(node_oid);
  if (payload.size() % 32 != 0 || payload.empty()) fail("corrupt directory node " + node_oid);
  for (size_t i = 0; i < payload.size() / 32; ++i) {
    const std::string_view ids(reinterpret_cast<const char*>(payload.data()), payload.size());
    const std::string child = hex_id_at(ids, i);
    walk_chunk_tree(child, levels - 1, sink);
  }
}

void ObjectStore::collect_chunk_tree(const std::string& node_oid, int levels,
                                     std::vector<std::string>* data_ids,
                                     std::vector<std::string>* dir_ids) {
  if (levels <= 0) {
    if (data_ids) data_ids->push_back(node_oid);
    return;
  }
  if (dir_ids) dir_ids->push_back(node_oid);
  const Bytes payload = load_dir_node(node_oid);
  const std::string_view ids(reinterpret_cast<const char*>(payload.data()), payload.size());
  for (size_t i = 0; i < payload.size() / 32; ++i) {
    collect_chunk_tree(hex_id_at(ids, i), levels - 1, data_ids, dir_ids);
  }
}

std::string ObjectStore::read_at(std::string_view oid, ObjType* type, int depth) {
  const auto meta = load_meta(oid);
  if (!meta) fail("unknown object " + std::string(oid));
  if (type) *type = meta->type;

  std::string payload;
  switch (meta->storage) {
    case 0: payload = meta->payload; break;
    case 1: payload = lz::lz1_decompress(bytes_span(meta->payload)); break;
    case 2: {
      if (meta->base_oid.empty()) fail("delta object without base " + std::string(oid));
      if (depth >= 64) fail("delta chain too deep at object " + std::string(oid));
      const std::string base = read_at(meta->base_oid, nullptr, depth + 1);
      payload = delta::apply_delta(bytes_span(base), bytes_span(meta->payload));
      break;
    }
    case 3: {
      payload.clear();
      payload.reserve(static_cast<size_t>(meta->raw_size));
      if (meta->payload.size() == 33) {
        const int levels = static_cast<uint8_t>(meta->payload[0]);
        const std::string root = to_hex(ByteSpan(
            reinterpret_cast<const uint8_t*>(meta->payload.data()) + 1, 32));
        walk_chunk_tree(root, levels, [&](ByteSpan slice) {
          payload.append(reinterpret_cast<const char*>(slice.data()), slice.size());
        });
      } else if (meta->payload.size() % 32 == 0) {
        for (size_t i = 0; i < meta->payload.size() / 32; ++i) {
          const Bytes data = load_data_chunk(hex_id_at(meta->payload, i));
          payload.append(reinterpret_cast<const char*>(data.data()), data.size());
        }
      } else {
        fail("corrupt chunk tree in object " + std::string(oid));
      }
      break;
    }
    default:
      fail("unsupported object storage " + std::to_string(meta->storage));
  }

  if (static_cast<int64_t>(payload.size()) != meta->raw_size) {
    fail("size mismatch for object " + std::string(oid));
  }
  if (object_id(meta->type, payload) != std::string(oid)) {
    fail("hash mismatch for object " + std::string(oid));
  }
  return payload;
}

void ObjectStore::write_to_file(std::string_view oid, const std::filesystem::path& path) {
  // Write a fresh temporary file and atomically replace the destination: this
  // avoids partial files and breaks hard links (restore must never write
  // through a link into a file outside the repository).
  std::filesystem::path temp = path;
  temp += ".iaqs-tmp";
  {
    std::ofstream out(temp, std::ios::binary | std::ios::trunc);
    if (!out) fail("cannot open " + u8(temp));
    read_stream(oid, [&](ByteSpan slice) {
      out.write(reinterpret_cast<const char*>(slice.data()),
                static_cast<std::streamsize>(slice.size()));
    });
    if (!out) fail("write failed: " + u8(temp));
    out.flush();
    if (!out) fail("write failed: " + u8(temp));
  }
#if defined(_WIN32)
  if (!MoveFileExW(temp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING)) {
    std::error_code ec;
    std::filesystem::remove(temp, ec);
    fail("cannot replace " + u8(path));
  }
#else
  std::error_code ec;
  std::filesystem::rename(temp, path, ec);
  if (ec) {
    std::filesystem::remove(temp, ec);
    fail("cannot replace " + u8(path));
  }
#endif
}

std::vector<ObjectStore::StoredObject> ObjectStore::list_objects() {
  std::vector<StoredObject> objects;
  for (const auto& [rid, row] : db_.scan_rows("objects")) {
    if (row.values.size() < 5) continue;
    if (row.values[0].type != ValueType::Text) continue;
    StoredObject object;
    object.oid = row.values[0].bytes;
    object.type = static_cast<ObjType>(row.values[1].int_value);
    object.raw_size = row.values[2].int_value;
    object.storage = row.values[3].int_value;
    if (row.values[4].type == ValueType::Text) object.base_oid = row.values[4].bytes;
    if (row.values.size() > 5 && row.values[5].type == ValueType::Blob) {
      object.stored_bytes = static_cast<int64_t>(row.values[5].bytes.size());
    }
    if (row.values.size() > 7) object.created_ts = row.values[7].int_value;
    objects.push_back(std::move(object));
  }
  return objects;
}

int64_t ObjectStore::stored_bytes(std::string_view oid) {
  const auto meta = load_meta(oid);
  if (!meta) fail("unknown object " + std::string(oid));
  return static_cast<int64_t>(meta->payload.size());
}

void ObjectStore::store_delta(std::string_view oid, std::string_view base_oid,
                              std::string_view delta, int64_t raw_size) {
  if (base_oid.empty()) fail("empty delta base");
  for (const auto& [rid, row] : db_.scan_rows("objects")) {
    if (row_text(row, 0) != std::string(oid)) continue;
    if (base_oid == oid) fail("object cannot be its own delta base");
    Row updated;
    updated.values = {
        Value::text(Bytes(oid)),
        Value::integer(row.values[1].int_value),
        Value::integer(raw_size),
        Value::integer(2),
        Value::text(Bytes(base_oid)),
        Value::blob(Bytes(delta)),
        Value::integer(0),
        Value::integer(row.values[7].int_value),
    };
    db_.update_row("objects", rid, updated);
    chunk_index_loaded_ = false;
    return;
  }
  fail("unknown object " + std::string(oid));
}

void ObjectStore::remove(std::string_view oid) {
  for (const auto& [rid, row] : db_.scan_rows("objects")) {
    if (row_text(row, 0) != std::string(oid)) continue;

    std::vector<std::string> data_ids;
    std::vector<std::string> removed_dirs;
    const std::string payload = row.values.size() > 5 && row.values[5].type == ValueType::Blob
                                    ? row.values[5].bytes
                                    : std::string();
    if (storage_of(row) == 3 && payload.size() == 33) {
      const int levels = static_cast<uint8_t>(payload[0]);
      const std::string root =
          to_hex(ByteSpan(reinterpret_cast<const uint8_t*>(payload.data()) + 1, 32));
      collect_chunk_tree(root, levels, &data_ids, &removed_dirs);
    } else if (storage_of(row) == 3 && payload.size() % 32 == 0) {
      for (size_t i = 0; i < payload.size() / 32; ++i) data_ids.push_back(hex_id_at(payload, i));
    }

    db_.delete_row("objects", rid);
    chunk_index_loaded_ = false;
    if (data_ids.empty() && removed_dirs.empty()) return;

    // Recompute referenced ids across surviving chunked objects.
    std::unordered_set<std::string> referenced_chunks;
    std::unordered_set<std::string> referenced_dirs;
    for (const auto& [other_rid, other] : db_.scan_rows("objects")) {
      if (!is_chunked_row(other)) continue;
      const std::string other_payload = other.values[5].bytes;
      if (other_payload.size() == 33) {
        const int levels = static_cast<uint8_t>(other_payload[0]);
        const std::string root = to_hex(ByteSpan(
            reinterpret_cast<const uint8_t*>(other_payload.data()) + 1, 32));
        std::vector<std::string> other_data;
        std::vector<std::string> other_dirs;
        collect_chunk_tree(root, levels, &other_data, &other_dirs);
        for (auto& id : other_data) referenced_chunks.insert(std::move(id));
        for (auto& id : other_dirs) referenced_dirs.insert(std::move(id));
      } else if (other_payload.size() % 32 == 0) {
        for (size_t i = 0; i < other_payload.size() / 32; ++i) {
          referenced_chunks.insert(hex_id_at(other_payload, i));
        }
      }
    }

    for (const auto& cid : data_ids) {
      if (referenced_chunks.count(cid)) continue;
      for (const auto& [chunk_rid, chunk_row] : db_.scan_rows("chunks")) {
        if (row_text(chunk_row, 0) == cid) {
          db_.delete_row("chunks", chunk_rid);
          index_erase(false, cid);
          break;
        }
      }
    }
    for (const auto& did : removed_dirs) {
      if (referenced_dirs.count(did)) continue;
      for (const auto& [dir_rid, dir_row] : db_.scan_rows("chunk_dirs")) {
        if (row_text(dir_row, 0) == did) {
          db_.delete_row("chunk_dirs", dir_rid);
          index_erase(true, did);
          break;
        }
      }
    }
    chunk_index_loaded_ = false;
    return;
  }
  fail("unknown object " + std::string(oid));
}

}  // namespace iaqs::vcs
