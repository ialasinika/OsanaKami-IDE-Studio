// Repository layer: a work tree over the object database.
#pragma once

#include <cstdint>
#include <filesystem>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "db/database.h"
#include "vcs/objects.h"
#include "vcs/store.h"

namespace iaqs::vcs {

struct IndexEntry {
  std::string path;  // repo-relative, '/' separated
  uint32_t mode = kModeFile;
  std::string oid;
  int64_t size = 0;
  int64_t mtime_ns = 0;
};

struct StatusReport {
  std::vector<std::string> staged_added;
  std::vector<std::string> staged_modified;
  std::vector<std::string> staged_deleted;
  std::vector<std::string> modified;
  std::vector<std::string> deleted;
  std::vector<std::string> untracked;
  // Declared placeholders whose file is still absent from the work tree.
  std::vector<std::string> placeholders_pending;

  bool clean() const {
    return staged_added.empty() && staged_modified.empty() &&
           staged_deleted.empty() && modified.empty() && deleted.empty() &&
           untracked.empty() && placeholders_pending.empty();
  }
};

struct LogEntry {
  std::string oid;
  Commit commit;
};

// A declared path that is not added yet (TODO-style intent): the file is
// planned but missing because it is unimplemented or not obtained yet.
struct PlaceholderInfo {
  std::string path;
  std::string reason;
  int64_t created_ts = 0;
};

class Repo {
 public:
  // Walks upwards from `start` until a directory containing `.iaqs/` is found.
  static std::filesystem::path find_root(const std::filesystem::path& start);

  static Repo init(const std::filesystem::path& workdir);
  // The database lives under `store_root` (where `.iaqs/` is created);
  // `workdir` is the tree whose files the versions describe.
  static Repo init(const std::filesystem::path& workdir,
                   const std::filesystem::path& store_root);
  static Repo open(const std::filesystem::path& workdir);
  static Repo open(const std::filesystem::path& workdir,
                   const std::filesystem::path& store_root);

  Repo(Repo&&) = default;
  Repo& operator=(Repo&&) = default;
  Repo(const Repo&) = delete;
  Repo& operator=(const Repo&) = delete;

  const std::filesystem::path& workdir() const { return workdir_; }
  const std::filesystem::path& store_dir() const { return store_dir_; }
  std::filesystem::path iaqs_dir() const { return store_dir_ / ".iaqs"; }
  db::Database& database() { return db_; }
  ObjectStore& objects() { return store_; }

  // ------------------------------------------------------------- refs / HEAD
  std::optional<std::string> ref_oid(std::string_view name);
  std::string head_ref();                 // e.g. "refs/heads/main"
  std::optional<std::string> head_oid();  // nullopt when the branch is unborn
  void set_head_symbolic(std::string_view ref);
  // Detaches HEAD at an explicit commit (used by import-git for a detached
  // git checkout).
  void set_head_detached(const std::string& oid);
  void update_ref(std::string_view name, const std::string& oid,
                  std::string_view message);

  // Resolves HEAD / branch / tag / refs/... / full or abbreviated oid, with
  // ^, ^N and ~N suffixes. Throws std::runtime_error when unresolvable.
  std::string resolve(std::string_view rev);
  // Follows annotated tag objects until a non-tag object is reached.
  std::string peel(std::string_view oid);

  // ------------------------------------------------------------- index
  std::vector<IndexEntry> load_index();
  void add_paths(const std::vector<std::string>& paths, bool all);
  void remove_index_path(std::string_view path);
  StatusReport status();

  // ------------------------------------------------------------- placeholders
  // Declares a planned-but-missing path (path + reason). Adding the real file
  // later fulfils (removes) the placeholder automatically.
  void add_placeholder(std::string_view path, std::string_view reason);
  bool remove_placeholder(std::string_view path);
  std::vector<PlaceholderInfo> list_placeholders();

  // Removes files from the work tree and stages their deletion (or only
  // unstages with `cached`).
  void rm_paths(const std::vector<std::string>& paths, bool cached);
  // Renames a tracked file on disk and in the index.
  void mv_path(std::string_view from, std::string_view to);
  // Restores work tree + index entries from HEAD (all paths when empty).
  // Restores tracked paths from HEAD; an empty list means the whole tree.
  // Returns how many paths were written.
  std::size_t restore_paths(const std::vector<std::string>& paths);
  // Deletes untracked files; returns the paths it removed (or would remove).
  std::vector<std::string> clean_untracked(bool dry_run);

  // ------------------------------------------------------------- trees / commits
  std::string tree_from_index(const std::vector<IndexEntry>& entries);
  std::vector<IndexEntry> flatten_tree(const std::string& tree_oid,
                                       const std::string& prefix = "");
  std::vector<TreeEntry> read_tree(const std::string& tree_oid);
  Commit read_commit(const std::string& commit_oid);
  std::string write_commit(const Commit& commit);
  std::string commit(std::string_view message, bool allow_empty, bool amend);
  std::vector<LogEntry> log(size_t max, bool all);

  // ------------------------------------------------------------- history / merge
  bool is_ancestor(const std::string& ancestor, const std::string& descendant);
  std::string merge_base(const std::string& a, const std::string& b);  // "" if unrelated

  struct MergeOutcome {
    enum class Kind { UpToDate, FastForward, Merged, Conflicted };
    Kind kind = Kind::UpToDate;
    std::string commit_oid;
    std::vector<std::string> conflicts;
  };
  MergeOutcome merge(std::string_view rev);
  bool merge_in_progress();

  // ------------------------------------------------------------- tags / reset
  struct TagInfo {
    std::string name;
    std::string oid;     // tag object (annotated tags) or commit
    std::string object;  // peeled target
    std::string message;
  };
  std::string create_tag(std::string_view name, std::string_view rev,
                         std::string_view message);
  std::vector<TagInfo> list_tags();
  void delete_tag(std::string_view name);
  void delete_ref(std::string_view name);

  // Moves the current branch (or detached HEAD) to `rev` and rewrites the
  // work tree and index to match it (git reset --hard semantics).
  void reset_hard(std::string_view rev);

  // ------------------------------------------------------------- maintenance
  // All refs (heads and tags) as (name, oid) pairs.
  std::vector<std::pair<std::string, std::string>> list_refs();

  struct GcOptions {
    bool dry_run = false;
    // Incremental gc is the default: only objects created since the previous gc
    // (meta key `gc.last_ts`) are considered for delta encoding and removal, and
    // objects already stored as IAQSD1 deltas (storage=2) are never re-encoded.
    // `full` (or incremental=false) keeps the classic whole-repository repack.
    bool incremental = true;
    bool full = false;
    size_t max_chain = 16;   // maximum delta chain depth
    size_t window = 8;       // how many previous versions to try as a base
    double min_saving = 0.5; // required saving vs. current stored payload

    bool full_repack() const { return full || !incremental; }
  };

  struct GcStats {
    bool incremental = true;       // false when this pass repacked everything
    size_t objects_scanned = 0;    // objects reachable from refs/HEAD
    size_t candidate_objects = 0;  // objects created since the previous gc
    size_t deltas_written = 0;     // deltas encoded during this pass
    size_t deltas_kept = 0;        // pre-existing deltas left untouched
    size_t objects_removed = 0;
    int64_t bytes_before = 0;
    int64_t bytes_after = 0;
    int64_t saved_bytes() const { return bytes_before - bytes_after; }
  };

  // Rewrites recent blob history as delta chains and drops objects unreachable
  // from refs/HEAD. Incremental by default (see GcOptions); a full repack
  // reconsiders every object. A dry run estimates the same numbers without
  // writing anything, including the gc.last_ts bookmark. Objects referenced by
  // reflog or index only are not kept (single user).
  GcStats gc();
  GcStats gc(const GcOptions& options);

  struct FsckReport {
    size_t objects = 0;
    size_t commits = 0;
    size_t trees = 0;
    size_t blobs = 0;
    size_t tags = 0;
    std::vector<std::string> errors;
    bool ok() const { return errors.empty(); }
  };

  // Verifies hashes, object links and refs. Never modifies data.
  FsckReport fsck();
  // ------------------------------------------------------------- checkout
  void checkout_tree(const std::string& tree_oid);
  void checkout_commit(std::string_view rev, bool force);

  // ------------------------------------------------------------- config
  std::string config_get(std::string_view key, std::string_view fallback = {}) const;
  void config_set(std::string_view key, std::string_view value);

  // Initializes all version-control tables (idempotent), used by init/open.
  void ensure_schema();
  void set_default_config();

 private:
  Repo(std::filesystem::path workdir, std::filesystem::path store_dir,
       db::Database database);

  std::vector<IndexEntry> tracked_files();  // files on disk, ignored ones excluded
  Bytes read_blob(const std::string& oid);
  std::string write_working_file(const std::string& rel_path);
  void insert_index_entry(const IndexEntry& entry);
  std::map<std::string, IndexEntry> head_files();
  void insert_reflog(std::string_view ref, const std::string& old_oid,
                     const std::string& new_oid, std::string_view message);
  std::string current_tz();
  std::optional<std::string> meta_get(std::string_view key);
  void meta_set(std::string_view key, std::string_view value);
  void meta_remove(std::string_view key);
  std::map<std::string, int> ancestor_depths(const std::string& oid);
  void replace_index(const std::vector<IndexEntry>& entries);

  std::filesystem::path workdir_;
  std::filesystem::path store_dir_;
  db::Database db_;
  ObjectStore store_;
};

// "2026-10-20 17:30 +0800" for a unix timestamp.
std::string format_time(int64_t ts, std::string_view tz);
int64_t now_seconds();
std::string local_tz();

}  // namespace iaqs::vcs
