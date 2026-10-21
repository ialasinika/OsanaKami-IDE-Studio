#include <cstdio>
#include <filesystem>
#include <random>
#include <stdexcept>
#include <string>

#include "core/util.h"
#include "db/database.h"
#include "harness.h"
#include "sql/exec.h"
#include "vcs/objects.h"
#include "vcs/store.h"

using namespace iaqs;

namespace {

namespace fs = std::filesystem;

struct TempDir {
  fs::path path;
  TempDir() {
    std::random_device rd;
    char suffix[32];
    std::snprintf(suffix, sizeof(suffix), "iaqs-store-%08x", rd());
    path = fs::temp_directory_path() / suffix;
    fs::create_directories(path);
  }
  ~TempDir() {
    std::error_code ec;
    fs::remove_all(path, ec);
  }
};

std::string pattern(size_t size) {
  std::string out;
  out.reserve(size);
  for (size_t i = 0; i < size; ++i) out.push_back(static_cast<char>('A' + (i % 26)));
  return out;
}

}  // namespace

IAQS_TEST(vcs_store, blob_roundtrip_and_dedupe) {
  TempDir dir;
  db::Database database = db::Database::create(dir.path.string(), "pw", 8192);
  vcs::ObjectStore store(database);
  store.ensure_schema();

  const Bytes payload = "hello world";
  const std::string first = store.write(vcs::ObjType::Blob, payload);
  const std::string second = store.write(vcs::ObjType::Blob, payload);
  CHECK_EQ(first, second);
  CHECK_EQ(first.size(), 64u);
  CHECK(store.has(first));
  CHECK(store.type_of(first) == vcs::ObjType::Blob);
  CHECK_EQ(store.read(first), payload);
  database.close();
}

IAQS_TEST(vcs_store, compressible_blob_roundtrip) {
  TempDir dir;
  db::Database database = db::Database::create(dir.path.string(), "pw", 8192);
  vcs::ObjectStore store(database);
  store.ensure_schema();

  const Bytes payload(6000, 'a');
  const std::string oid = store.write(vcs::ObjType::Blob, payload);
  CHECK_EQ(store.read(oid), payload);
  CHECK(store.type_of(oid) == vcs::ObjType::Blob);
  database.close();
}

IAQS_TEST(vcs_store, large_blob_is_chunked_and_roundtrips) {
  TempDir dir;
  db::Database database = db::Database::create(dir.path.string(), "pw", 8192);
  vcs::ObjectStore store(database);
  store.ensure_schema();

  const Bytes payload = pattern(20000);
  const std::string oid = store.write(vcs::ObjType::Blob, payload);
  CHECK_EQ(store.read(oid), payload);
  database.close();
}

IAQS_TEST(vcs_store, tree_object_roundtrip) {
  TempDir dir;
  db::Database database = db::Database::create(dir.path.string(), "pw", 8192);
  vcs::ObjectStore store(database);
  store.ensure_schema();

  std::vector<vcs::TreeEntry> entries;
  entries.push_back({vcs::kModeFile, vcs::ObjType::Blob, std::string(64, 'a'), "a.txt"});
  const Bytes encoded = vcs::encode_tree(entries);
  const std::string oid = store.write(vcs::ObjType::Tree, encoded);
  CHECK(store.type_of(oid) == vcs::ObjType::Tree);
  CHECK_EQ(store.read(oid), encoded);
  database.close();
}

IAQS_TEST(vcs_store, missing_object_throws) {
  TempDir dir;
  db::Database database = db::Database::create(dir.path.string(), "pw", 8192);
  vcs::ObjectStore store(database);
  store.ensure_schema();
  CHECK_THROW(store.read(std::string(64, '0')), std::runtime_error);
  database.close();
}

IAQS_TEST(vcs_store, truncated_read_is_rejected) {
  TempDir dir;
  db::Database database = db::Database::create(dir.path.string(), "pw", 8192);
  vcs::ObjectStore store(database);
  store.ensure_schema();

  const std::string oid = store.write(vcs::ObjType::Blob, "payload");
  // Deleting the object must make reads fail rather than return garbage.
  sql::SqlExecutor executor(database);
  executor.execute("DELETE FROM objects WHERE oid = '" + oid + "';");
  CHECK_THROW(store.read(oid), std::runtime_error);
  database.close();
}
