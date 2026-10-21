#include <cstdio>
#include <filesystem>
#include <map>
#include <optional>
#include <random>
#include <stdexcept>
#include <string>
#include <utility>

#include "core/util.h"
#include "db/database.h"
#include "db/row.h"
#include "harness.h"
#include "sql/exec.h"
#include "vcs/repo.h"

using namespace iaqs;

namespace {

namespace fs = std::filesystem;

struct TempDir {
  fs::path path;
  TempDir() {
    std::random_device rd;
    char suffix[32];
    std::snprintf(suffix, sizeof(suffix), "iaqs-gc-%08x", rd());
    path = fs::temp_directory_path() / suffix;
    fs::create_directories(path);
  }
  ~TempDir() {
    std::error_code ec;
    fs::remove_all(path, ec);
  }
};

void write_text(const fs::path& file, std::string_view text) {
  write_file(file.string(), bytes_span(text));
}

std::string file_content(vcs::Repo& repo, const std::string& path) {
  const std::string commit = repo.peel(repo.resolve("HEAD"));
  const std::string tree = repo.read_commit(commit).tree;
  for (const auto& entry : repo.flatten_tree(tree)) {
    if (entry.path == path) {
      return repo.objects().read(entry.oid);
    }
  }
  return {};
}

std::size_t count_storage(vcs::Repo& repo, int64_t storage) {
  std::size_t count = 0;
  for (const auto& object : repo.objects().list_objects()) {
    if (object.storage == storage) ++count;
  }
  return count;
}

// ~400 lines with a single changed line per revision: compresses to a tiny
// delta against its predecessor, so gc has an obvious base to pick.
std::string big_content(int rev) {
  std::string text;
  for (int i = 0; i < 400; ++i) {
    if (i == 200) {
      text += "line " + std::to_string(200 + rev) + "\n";
    } else {
      text += "line " + std::to_string(i) + "\n";
    }
  }
  return text;
}

std::size_t object_count(vcs::Repo& repo) { return repo.objects().list_objects().size(); }

int64_t storage_of(vcs::Repo& repo, const std::string& oid) {
  for (const auto& object : repo.objects().list_objects()) {
    if (object.oid == oid) return object.storage;
  }
  return -1;
}

std::optional<std::string> meta_value(vcs::Repo& repo, std::string_view key) {
  for (const auto& [rid, row] : repo.database().scan_rows("meta")) {
    (void)rid;
    if (row.values.size() >= 2 && row.values[0].bytes == std::string(key)) {
      return row.values[1].bytes;
    }
  }
  return std::nullopt;
}

// The blob of `path` in a specific commit (file_content only looks at HEAD).
std::string blob_at(vcs::Repo& repo, const std::string& commit_oid, const std::string& path) {
  for (const auto& entry : repo.flatten_tree(repo.read_commit(commit_oid).tree)) {
    if (entry.path == path) return entry.oid;
  }
  return {};
}

// Rewrites every objects.created_ts, so gc candidate sets do not depend on how
// long the test takes relative to the wall clock.
void age_all_objects(vcs::Repo& repo, int64_t ts) {
  for (const auto& [rid, row] : repo.database().scan_rows("objects")) {
    db::Row next = row;
    next.values[7] = db::Value::integer(ts);
    repo.database().update_row("objects", rid, next);
  }
}

void set_created_ts(vcs::Repo& repo, const std::string& oid, int64_t ts) {
  for (const auto& [rid, row] : repo.database().scan_rows("objects")) {
    if (row.values.empty() || row.values[0].bytes != oid) continue;
    db::Row next = row;
    next.values[7] = db::Value::integer(ts);
    repo.database().update_row("objects", rid, next);
    return;
  }
  throw std::runtime_error("missing object " + oid);
}

// storage=2 rows are the incremental gc's evidence: base_oid + stored payload.
std::map<std::string, std::pair<std::string, std::string>> delta_rows(vcs::Repo& repo) {
  std::map<std::string, std::pair<std::string, std::string>> rows;
  for (const auto& [rid, row] : repo.database().scan_rows("objects")) {
    (void)rid;
    if (row.values.size() < 8 || row.values[3].int_value != 2) continue;
    const std::string base =
        row.values[4].type == db::ValueType::Text ? row.values[4].bytes : std::string();
    rows[row.values[0].bytes] = {base, row.values[5].bytes};
  }
  return rows;
}

// Turns a delta (or any object) back into a plain inline payload written before
// the gc bookmark, as an old build or an import could have left it.
void make_plain_old(vcs::Repo& repo, const std::string& oid, std::string_view payload,
                    int64_t created_ts) {
  for (const auto& [rid, row] : repo.database().scan_rows("objects")) {
    if (row.values.empty() || row.values[0].bytes != oid) continue;
    db::Row next = row;
    next.values[3] = db::Value::integer(0);  // storage: plain inline payload
    next.values[4] = db::Value::null();      // no delta base
    next.values[5] = db::Value::blob(Bytes(payload));
    next.values[7] = db::Value::integer(created_ts);
    repo.database().update_row("objects", rid, next);
    return;
  }
  throw std::runtime_error("missing object " + oid);
}

}  // namespace

IAQS_TEST(gc, repacks_history_as_deltas) {
  TempDir tmp;
  vcs::Repo repo = vcs::Repo::init(tmp.path, "pw");
  auto make_content = [](int rev) {
    std::string text;
    for (int i = 0; i < 400; ++i) {
      if (i == 200) {
        text += "line " + std::to_string(200 + rev) + "\n";
      } else {
        text += "line " + std::to_string(i) + "\n";
      }
    }
    return text;
  };
  std::string content = make_content(0);
  write_text(tmp.path / "big.txt", content);
  repo.add_paths({"big.txt"}, false);
  repo.commit("base", false, false);

  for (int rev = 1; rev <= 5; ++rev) {
    content = make_content(rev);
    write_text(tmp.path / "big.txt", content);
    repo.add_paths({"big.txt"}, false);
    repo.commit("rev " + std::to_string(rev), false, false);
  }

  const std::size_t deltas_before = count_storage(repo, 2);
  const auto stats = repo.gc();
  CHECK_EQ(stats.objects_removed, std::size_t{0});
  CHECK(stats.deltas_written >= 4);
  CHECK(stats.bytes_after < stats.bytes_before);
  CHECK(count_storage(repo, 2) >= deltas_before + 4);

  // Data is still readable and hashes still verify after repacking.
  CHECK_EQ(file_content(repo, "big.txt"), content);
  const auto report = repo.fsck();
  CHECK(report.ok());
  CHECK_EQ(report.errors.size(), std::size_t{0});

  // A restart must still resolve delta chains.
  const std::string password = "pw";
  repo.database().close();
  vcs::Repo reopened = vcs::Repo::open(tmp.path, password);
  CHECK_EQ(file_content(reopened, "big.txt"), content);
  reopened.database().close();
}

IAQS_TEST(gc, dry_run_does_not_modify) {
  TempDir tmp;
  vcs::Repo repo = vcs::Repo::init(tmp.path, "pw");
  std::string content;
  for (int i = 0; i < 50; ++i) content += "line " + std::to_string(i) + "\n";
  write_text(tmp.path / "a.txt", content);
  repo.add_paths({"a.txt"}, false);
  repo.commit("one", false, false);
  content += "tail\n";
  write_text(tmp.path / "a.txt", content);
  repo.add_paths({"a.txt"}, false);
  repo.commit("two", false, false);

  const std::string orphan = repo.objects().write(vcs::ObjType::Blob, "orphan payload");
  const std::size_t objects_before = repo.objects().list_objects().size();
  const std::size_t deltas_before = count_storage(repo, 2);

  vcs::Repo::GcOptions options;
  options.dry_run = true;
  const auto dry = repo.gc(options);
  CHECK(dry.deltas_written >= 1);
  CHECK_EQ(repo.objects().list_objects().size(), objects_before);
  CHECK_EQ(count_storage(repo, 2), deltas_before);
  CHECK(repo.objects().has(orphan));
  CHECK(dry.bytes_after < dry.bytes_before);

  const auto stats = repo.gc();
  CHECK_EQ(repo.objects().has(orphan), false);
  CHECK(stats.objects_removed >= 1);
  CHECK(repo.fsck().ok());
  CHECK_EQ(file_content(repo, "a.txt"), content);
  repo.database().close();
}

IAQS_TEST(gc, fsck_reports_missing_objects) {
  TempDir tmp;
  vcs::Repo repo = vcs::Repo::init(tmp.path, "pw");
  write_text(tmp.path / "a.txt", "hello\n");
  repo.add_paths({"a.txt"}, false);
  repo.commit("one", false, false);

  const auto index = repo.load_index();
  CHECK_EQ(index.size(), std::size_t{1});
  const std::string blob = index[0].oid;
  CHECK(repo.objects().has(blob));

  sql::SqlExecutor executor(repo.database());
  executor.execute("DELETE FROM objects WHERE oid = '" + blob + "';");
  const auto report = repo.fsck();
  CHECK(!report.ok());
  CHECK(!report.errors.empty());
  repo.database().close();
}

// The default pass is incremental: after the first gc records gc.last_ts, only
// objects written since then are considered, and existing storage=2 rows must
// keep their exact base_oid and payload bytes (no re-encoding).
IAQS_TEST(gc, incremental_keeps_existing_deltas) {
  TempDir tmp;
  vcs::Repo repo = vcs::Repo::init(tmp.path, "pw");
  std::string content = big_content(0);
  write_text(tmp.path / "big.txt", content);
  repo.add_paths({"big.txt"}, false);
  repo.commit("base", false, false);
  for (int rev = 1; rev <= 2; ++rev) {
    content = big_content(rev);
    write_text(tmp.path / "big.txt", content);
    repo.add_paths({"big.txt"}, false);
    repo.commit("rev " + std::to_string(rev), false, false);
  }
  // Everything written so far predates the bookmark the first gc will record.
  age_all_objects(repo, 1000);

  const auto first = repo.gc();
  CHECK_EQ(first.incremental, true);
  CHECK_EQ(first.candidate_objects, object_count(repo));  // no bookmark yet: all
  CHECK(first.deltas_written >= 2);
  CHECK(meta_value(repo, "gc.last_ts").has_value());
  const std::size_t deltas_before = count_storage(repo, 2);
  CHECK(deltas_before >= 2);
  const auto before_rows = delta_rows(repo);
  CHECK_EQ(before_rows.size(), deltas_before);
  const std::string generation = meta_value(repo, "gc.generation").value_or("");

  // One revision after the bookmark: only the new objects are candidates.
  content = big_content(3);
  write_text(tmp.path / "big.txt", content);
  repo.add_paths({"big.txt"}, false);
  repo.commit("rev 3", false, false);
  const std::size_t total = object_count(repo);

  const auto second = repo.gc();
  CHECK_EQ(second.incremental, true);
  CHECK(second.candidate_objects > 0);
  CHECK(second.candidate_objects < total);
  CHECK(second.deltas_written >= 1);
  CHECK_EQ(second.deltas_kept, deltas_before);
  CHECK_EQ(second.objects_removed, std::size_t{0});
  CHECK_EQ(count_storage(repo, 2), deltas_before + 1);
  CHECK(meta_value(repo, "gc.generation").value_or("") != generation);

  // Every pre-existing delta keeps the very same base and stored payload.
  const auto after_rows = delta_rows(repo);
  std::size_t unchanged = 0;
  for (const auto& [oid, row] : before_rows) {
    const auto found = after_rows.find(oid);
    CHECK(found != after_rows.end());
    if (found == after_rows.end()) continue;
    CHECK_EQ(found->second.first, row.first);
    CHECK_EQ(found->second.second, row.second);
    ++unchanged;
  }
  CHECK_EQ(unchanged, before_rows.size());

  CHECK_EQ(file_content(repo, "big.txt"), content);
  CHECK(repo.fsck().ok());
  repo.database().close();
}

// A dry run estimates the same work but writes nothing; in particular it must
// not advance gc.last_ts, or the next real pass would skip the new object.
IAQS_TEST(gc, incremental_dry_run_keeps_bookmark) {
  TempDir tmp;
  vcs::Repo repo = vcs::Repo::init(tmp.path, "pw");
  std::string content = big_content(0);
  write_text(tmp.path / "big.txt", content);
  repo.add_paths({"big.txt"}, false);
  repo.commit("base", false, false);
  content = big_content(1);
  write_text(tmp.path / "big.txt", content);
  repo.add_paths({"big.txt"}, false);
  repo.commit("rev 1", false, false);
  age_all_objects(repo, 1000);
  repo.gc();  // records the bookmark

  const std::string bookmark = meta_value(repo, "gc.last_ts").value_or("");
  const std::string generation = meta_value(repo, "gc.generation").value_or("");
  const std::size_t deltas_before = count_storage(repo, 2);
  const auto rows_before = delta_rows(repo);

  content = big_content(2);
  write_text(tmp.path / "big.txt", content);
  repo.add_paths({"big.txt"}, false);
  repo.commit("rev 2", false, false);
  const std::size_t total = object_count(repo);

  vcs::Repo::GcOptions dry;
  dry.dry_run = true;
  const auto dry_stats = repo.gc(dry);
  CHECK_EQ(dry_stats.incremental, true);
  CHECK(dry_stats.candidate_objects > 0);
  CHECK(dry_stats.candidate_objects < total);
  CHECK(dry_stats.deltas_written >= 1);
  CHECK_EQ(dry_stats.deltas_kept, deltas_before);
  CHECK(dry_stats.bytes_after < dry_stats.bytes_before);
  CHECK_EQ(dry_stats.objects_removed, std::size_t{0});

  // Nothing at all was written.
  CHECK_EQ(object_count(repo), total);
  CHECK_EQ(count_storage(repo, 2), deltas_before);
  CHECK_EQ(meta_value(repo, "gc.last_ts").value_or(""), bookmark);
  CHECK_EQ(meta_value(repo, "gc.generation").value_or(""), generation);
  const auto rows_after = delta_rows(repo);
  CHECK_EQ(rows_after.size(), rows_before.size());
  for (const auto& [oid, row] : rows_before) {
    const auto found = rows_after.find(oid);
    CHECK(found != rows_after.end());
    if (found == rows_after.end()) continue;
    CHECK_EQ(found->second.first, row.first);
    CHECK_EQ(found->second.second, row.second);
  }

  // Because the bookmark did not move, the real pass still sees the new blob.
  const auto real = repo.gc();
  CHECK(real.candidate_objects >= 1);
  CHECK(real.deltas_written >= 1);
  CHECK_EQ(count_storage(repo, 2), deltas_before + 1);
  CHECK(meta_value(repo, "gc.generation").value_or("") != generation);
  CHECK_EQ(file_content(repo, "big.txt"), content);
  CHECK(repo.fsck().ok());
  repo.database().close();
}

// Incremental removal is conservative: unreachable objects written after the
// last bookmark are reclaimed, older ones are left for a full repack.
IAQS_TEST(gc, incremental_removes_only_candidates) {
  TempDir tmp;
  vcs::Repo repo = vcs::Repo::init(tmp.path, "pw");
  std::string content = big_content(0);
  write_text(tmp.path / "big.txt", content);
  repo.add_paths({"big.txt"}, false);
  repo.commit("base", false, false);
  content = big_content(1);
  write_text(tmp.path / "big.txt", content);
  repo.add_paths({"big.txt"}, false);
  repo.commit("rev 1", false, false);
  age_all_objects(repo, 1000);
  repo.gc();

  const std::string old_orphan = repo.objects().write(vcs::ObjType::Blob, "old orphan payload");
  set_created_ts(repo, old_orphan, 1000);  // predates the bookmark
  const std::string new_orphan = repo.objects().write(vcs::ObjType::Blob, "new orphan payload");

  const auto incremental = repo.gc();
  CHECK_EQ(repo.objects().has(new_orphan), false);  // candidate: reclaimed
  CHECK_EQ(repo.objects().has(old_orphan), true);   // before bookmark: kept
  CHECK_EQ(incremental.objects_removed, std::size_t{1});
  CHECK(repo.fsck().ok());

  vcs::Repo::GcOptions full;
  full.full = true;
  const auto stats = repo.gc(full);
  CHECK_EQ(repo.objects().has(old_orphan), false);  // full pass reclaims it
  CHECK(stats.objects_removed >= 1);
  CHECK_EQ(stats.incremental, false);
  CHECK(repo.fsck().ok());
  repo.database().close();
}

// --full (or incremental=false) repacks everything, including objects older
// than the bookmark that the incremental pass deliberately skips.
IAQS_TEST(gc, full_repack_reconsiders_old_objects) {
  TempDir tmp;
  vcs::Repo repo = vcs::Repo::init(tmp.path, "pw");
  std::string content = big_content(0);
  write_text(tmp.path / "big.txt", content);
  repo.add_paths({"big.txt"}, false);
  repo.commit("base", false, false);
  content = big_content(1);
  write_text(tmp.path / "big.txt", content);
  repo.add_paths({"big.txt"}, false);
  repo.commit("rev 1", false, false);
  const std::string rev1_commit = repo.resolve("HEAD");
  const std::string blob1 = blob_at(repo, rev1_commit, "big.txt");
  age_all_objects(repo, 1000);
  repo.gc();
  CHECK_EQ(storage_of(repo, blob1), 2);  // the first pass delta-encoded it

  // Put blob1 back as a plain pre-bookmark object: the incremental pass skips
  // it, the full pass must re-encode it.
  make_plain_old(repo, blob1, content, 1000);
  CHECK_EQ(storage_of(repo, blob1), 0);

  content = big_content(2);
  write_text(tmp.path / "big.txt", content);
  repo.add_paths({"big.txt"}, false);
  repo.commit("rev 2", false, false);

  const auto incremental = repo.gc();
  CHECK(incremental.candidate_objects < object_count(repo));
  CHECK_EQ(storage_of(repo, blob1), 0);  // older than the bookmark: skipped
  CHECK(incremental.deltas_written >= 1);  // the new revision was encoded
  CHECK_EQ(file_content(repo, "big.txt"), content);
  CHECK(repo.fsck().ok());

  vcs::Repo::GcOptions full;
  full.full = true;
  const auto stats = repo.gc(full);
  CHECK_EQ(stats.incremental, false);
  CHECK_EQ(stats.candidate_objects, object_count(repo));
  CHECK_EQ(storage_of(repo, blob1), 2);  // reconsidered by the full pass
  CHECK(stats.deltas_written >= 1);
  CHECK_EQ(file_content(repo, "big.txt"), content);
  CHECK(repo.fsck().ok());
  repo.database().close();
}
