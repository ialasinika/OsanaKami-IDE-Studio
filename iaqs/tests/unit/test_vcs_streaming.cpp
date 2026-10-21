#include <algorithm>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <random>
#include <stdexcept>
#include <string>

#include "core/util.h"
#include "db/database.h"
#include "harness.h"
#include "sql/exec.h"
#include "vcs/objects.h"
#include "vcs/repo.h"
#include "vcs/store.h"

using namespace iaqs;

namespace {

namespace fs = std::filesystem;

struct TempDir {
  fs::path path;
  TempDir() {
    std::random_device rd;
    char suffix[32];
    std::snprintf(suffix, sizeof(suffix), "iaqs-stream-%08x", rd());
    path = fs::temp_directory_path() / suffix;
    fs::create_directories(path);
  }
  ~TempDir() {
    std::error_code ec;
    fs::remove_all(path, ec);
  }
};

std::string binary_payload(size_t size, uint32_t seed = 12345) {
  std::string out;
  out.resize(size);
  uint32_t state = seed;
  for (size_t i = 0; i < size; ++i) {
    state = state * 1664525u + 1013904223u;
    out[i] = static_cast<char>(state >> 24);
  }
  return out;
}

int64_t count_rows(db::Database& database, const std::string& table) {
  sql::SqlExecutor executor(database);
  const sql::ExecResult result = executor.execute("SELECT * FROM " + table + ";");
  return static_cast<int64_t>(result.rows.size());
}

}  // namespace

IAQS_TEST(vcs_streaming, write_stream_small_matches_object_id) {
  TempDir dir;
  db::Database database = db::Database::create(dir.path.string(), 8192);
  vcs::ObjectStore store(database);
  store.ensure_schema();

  const Bytes payload = "streamed small payload";
  size_t offset = 0;
  const std::string oid = store.write_stream(
      vcs::ObjType::Blob, payload.size(), [&](uint8_t* buffer, size_t capacity) {
        const size_t n = std::min(capacity, payload.size() - offset);
        std::memcpy(buffer, payload.data() + offset, n);
        offset += n;
        return n;
      });
  CHECK_EQ(oid, vcs::object_id(vcs::ObjType::Blob, payload));
  CHECK_EQ(store.read(oid), payload);
  database.close();
}

IAQS_TEST(vcs_streaming, large_stream_uses_chunk_tree) {
  TempDir dir;
  db::Database database = db::Database::create(dir.path.string(), 8192);
  vcs::ObjectStore store(database);
  store.ensure_schema();

  const std::string payload = binary_payload(200000);
  size_t offset = 0;
  const std::string oid = store.write_stream(
      vcs::ObjType::Blob, payload.size(), [&](uint8_t* buffer, size_t capacity) {
        const size_t n = std::min(capacity, payload.size() - offset);
        std::memcpy(buffer, payload.data() + offset, n);
        offset += n;
        return n;
      });
  CHECK_EQ(oid, vcs::object_id(vcs::ObjType::Blob, std::string_view(payload)));
  CHECK_EQ(count_rows(database, "chunks"), 49);
  CHECK_EQ(count_rows(database, "chunk_dirs"), 1);

  std::string streamed;
  store.read_stream(oid, [&](ByteSpan slice) {
    streamed.append(reinterpret_cast<const char*>(slice.data()), slice.size());
  });
  CHECK_EQ(streamed.size(), payload.size());
  CHECK(streamed == payload);
  CHECK(store.read(oid) == payload);
  database.close();
}

IAQS_TEST(vcs_streaming, identical_stream_is_deduped) {
  TempDir dir;
  db::Database database = db::Database::create(dir.path.string(), 8192);
  vcs::ObjectStore store(database);
  store.ensure_schema();

  const std::string payload = binary_payload(50000);
  auto writer = [&]() {
    size_t offset = 0;
    return store.write_stream(vcs::ObjType::Blob, payload.size(),
                              [&](uint8_t* buffer, size_t capacity) {
                                const size_t n = std::min(capacity, payload.size() - offset);
                                std::memcpy(buffer, payload.data() + offset, n);
                                offset += n;
                                return n;
                              });
  };
  const std::string first = writer();
  const int64_t chunks_after_first = count_rows(database, "chunks");
  const std::string second = writer();
  CHECK_EQ(first, second);
  CHECK_EQ(count_rows(database, "chunks"), chunks_after_first);
  database.close();
}

IAQS_TEST(vcs_streaming, corrupt_chunk_is_rejected) {
  TempDir dir;
  db::Database database = db::Database::create(dir.path.string(), 8192);
  vcs::ObjectStore store(database);
  store.ensure_schema();

  const std::string payload = binary_payload(30000);
  size_t offset = 0;
  const std::string oid = store.write_stream(
      vcs::ObjType::Blob, payload.size(), [&](uint8_t* buffer, size_t capacity) {
        const size_t n = std::min(capacity, payload.size() - offset);
        std::memcpy(buffer, payload.data() + offset, n);
        offset += n;
        return n;
      });

  sql::SqlExecutor executor(database);
  executor.execute("UPDATE chunks SET data = 'x';");
  CHECK_THROW(store.read(oid), std::runtime_error);
  database.close();
}

IAQS_TEST(vcs_streaming, chunk_index_is_rebuilt_when_missing) {
  TempDir dir;
  db::Database database = db::Database::create(dir.path.string(), 8192);
  const std::string payload = binary_payload(120000, 777);
  std::string oid;
  {
    vcs::ObjectStore store(database);
    store.ensure_schema();
    size_t offset = 0;
    oid = store.write_stream(vcs::ObjType::Blob, payload.size(),
                             [&](uint8_t* buffer, size_t capacity) {
                               const size_t n = std::min(capacity, payload.size() - offset);
                               std::memcpy(buffer, payload.data() + offset, n);
                               offset += n;
                               return n;
                             });
    CHECK_EQ(store.read(oid), payload);
  }

  // Dropping the index roots must not lose data: a fresh store rebuilds the
  // B+ trees from the chunks/chunk_dirs tables.
  sql::SqlExecutor(database).execute("DELETE FROM chunk_index;");
  vcs::ObjectStore reopened(database);
  reopened.ensure_schema();
  CHECK_EQ(count_rows(database, "chunk_index"), 2);
  CHECK(reopened.read(oid) == payload);
  database.close();
}

IAQS_TEST(vcs_streaming, repo_checkout_streams_large_blob) {
  TempDir dir;
  const fs::path root = dir.path / "work";
  fs::create_directories(root);
  const std::string payload = binary_payload(120000, 999);

  {
    vcs::Repo repo = vcs::Repo::init(root);
    {
      std::ofstream out(root / "big.bin", std::ios::binary | std::ios::trunc);
      out.write(payload.data(), static_cast<std::streamsize>(payload.size()));
    }
    repo.add_paths({}, true);
    repo.commit("add big blob", false, false);
  }

  fs::remove(root / "big.bin");
  {
    vcs::Repo repo = vcs::Repo::open(root);
    CHECK(!repo.status().clean());
    repo.checkout_commit("HEAD", true);
    CHECK(repo.status().clean());
  }
  std::ifstream in(root / "big.bin", std::ios::binary);
  std::string restored((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  CHECK_EQ(restored.size(), payload.size());
  CHECK(restored == payload);
}
