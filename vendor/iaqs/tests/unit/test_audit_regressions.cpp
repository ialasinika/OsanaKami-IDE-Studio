// Regression tests for the 2026-10 audit findings (VCS-H1/H2/H3/H5/H6).
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <functional>
#include <random>
#include <stdexcept>
#include <string>

#include "core/util.h"
#include "harness.h"
#include "vcs/merge.h"
#include "vcs/repo.h"

using namespace iaqs;

namespace {

namespace fs = std::filesystem;

struct TempDir {
  fs::path path;
  TempDir() {
    std::random_device rd;
    char suffix[48];
    std::snprintf(suffix, sizeof(suffix), "iaqs-audit-%08x%08x", rd(), rd());
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

std::string read_text(const fs::path& file) { return read_file(file.string()); }

void commit_file(vcs::Repo& repo, const fs::path& root, const std::string& path,
                 std::string_view content, std::string_view message) {
  write_text(root / path, content);
  repo.add_paths({path}, false);
  repo.commit(message, false, false);
}

// Builds a divergent history: main changes a.txt, feature changes a.txt too.
vcs::Repo diverged_repo(const fs::path& root) {
  vcs::Repo repo = vcs::Repo::init(root, "audit-password-123");
  commit_file(repo, root, "a.txt", "base\n", "base");
  const std::string base = *repo.head_oid();
  repo.database().begin();
  repo.update_ref("refs/heads/feature", base, "branch: created");
  repo.database().commit();
  commit_file(repo, root, "a.txt", "main\n", "main change");
  repo.set_head_symbolic("refs/heads/feature");
  repo.checkout_commit("HEAD", true);
  repo.set_head_symbolic("refs/heads/feature");
  commit_file(repo, root, "a.txt", "feature\n", "feature change");
  repo.set_head_symbolic("refs/heads/main");
  repo.checkout_commit("HEAD", true);
  repo.set_head_symbolic("refs/heads/main");
  return repo;
}

bool throws_containing(const std::function<void()>& fn, std::string_view needle) {
  try {
    fn();
  } catch (const std::exception& error) {
    return std::string(error.what()).find(needle) != std::string::npos;
  }
  return false;
}

}  // namespace

IAQS_TEST(vcs_repo, merge_refuses_uncommitted_worktree_changes) {
  TempDir tmp;
  vcs::Repo repo = diverged_repo(tmp.path);
  // Dirty, unstaged edit on main.
  write_text(tmp.path / "a.txt", "dirty local edit\n");
  CHECK(throws_containing([&] { repo.merge("feature"); }, "uncommitted"));
  // The local edit is preserved.
  CHECK_EQ(read_text(tmp.path / "a.txt"), std::string("dirty local edit\n"));
}

IAQS_TEST(vcs_repo, merge_refuses_staged_only_changes_and_keeps_file) {
  TempDir tmp;
  vcs::Repo repo = diverged_repo(tmp.path);
  write_text(tmp.path / "staged.txt", "only staged\n");
  repo.add_paths({"staged.txt"}, false);
  CHECK(throws_containing([&] { repo.merge("feature"); }, "uncommitted"));
  CHECK(fs::exists(tmp.path / "staged.txt"));
  CHECK_EQ(read_text(tmp.path / "staged.txt"), std::string("only staged\n"));
}

IAQS_TEST(vcs_merge, conflict_region_covers_all_changes_of_a_side) {
  const std::string base = "a\nb\nc\nd\ne\n";
  // Ours replaces b and c; theirs replaces b..c as one block.
  const std::string ours = "a\nB\nC\nd\ne\n";
  const std::string theirs = "a\nX\nd\ne\n";
  const vcs::MergeResult result = vcs::merge3(base, ours, theirs, "HEAD", "feature");
  CHECK(!result.clean);
  CHECK_EQ(result.conflicts, std::size_t{1});
  const std::size_t marker = result.content.find("=======\n");
  const std::size_t end_marker = result.content.find(">>>>>>> feature");
  CHECK(marker != std::string::npos);
  CHECK(end_marker != std::string::npos);
  CHECK(marker < end_marker);
  const std::string ours_side = result.content.substr(0, marker);
  // Both of our edits stay inside our side of the conflict block.
  CHECK(ours_side.find("B\nC\n") != std::string::npos);
  // Nothing of ours escapes after the conflict markers.
  const std::string after = result.content.substr(end_marker);
  CHECK(after.find("B\n") == std::string::npos);
  CHECK(after.find("C\n") == std::string::npos);
  // The untouched tail is still present.
  CHECK(result.content.find(">>>>>>> feature\nd\ne\n") != std::string::npos);
}

IAQS_TEST(vcs_repo, status_detects_same_size_edit_with_restored_mtime) {
  TempDir tmp;
  vcs::Repo repo = vcs::Repo::init(tmp.path, "audit-password-123");
  write_text(tmp.path / "a.txt", "aaaa\n");
  repo.add_paths({"a.txt"}, false);
  repo.commit("first", false, false);
  const fs::path file = tmp.path / "a.txt";
  const auto mtime = fs::last_write_time(file);
  write_text(file, "bbbb\n");  // same size, different content
  fs::last_write_time(file, mtime);
  const vcs::StatusReport status = repo.status();
  CHECK(!status.clean());
  CHECK_EQ(status.modified.size(), std::size_t{1});
  CHECK_EQ(status.modified.front(), std::string("a.txt"));
}

IAQS_TEST(vcs_repo, tag_names_are_validated) {
  TempDir tmp;
  vcs::Repo repo = vcs::Repo::init(tmp.path, "audit-password-123");
  write_text(tmp.path / "a.txt", "hello\n");
  repo.add_paths({"a.txt"}, false);
  repo.commit("first", false, false);
  CHECK(throws_containing([&] { repo.create_tag("../../pwned.txt", "HEAD", ""); },
                          "invalid tag name"));
  CHECK(throws_containing([&] { repo.create_tag("bad name", "HEAD", ""); },
                          "invalid tag name"));
  repo.create_tag("v1", "HEAD", "release");
  CHECK(throws_containing([&] { repo.create_tag("v1", "HEAD", "again"); },
                          "already exists"));
}

IAQS_TEST(vcs_repo, merge_refuses_to_overwrite_untracked_files) {
  TempDir tmp;
  vcs::Repo repo = diverged_repo(tmp.path);
  // feature adds a file that main has not seen.
  repo.set_head_symbolic("refs/heads/feature");
  repo.checkout_commit("HEAD", true);
  repo.set_head_symbolic("refs/heads/feature");
  commit_file(repo, tmp.path, "u.txt", "from feature\n", "feature adds u");
  repo.set_head_symbolic("refs/heads/main");
  repo.checkout_commit("HEAD", true);
  repo.set_head_symbolic("refs/heads/main");
  // Local untracked file at the same path.
  write_text(tmp.path / "u.txt", "local untracked\n");
  CHECK(throws_containing([&] { repo.merge("feature"); }, "untracked file"));
  CHECK_EQ(read_text(tmp.path / "u.txt"), std::string("local untracked\n"));
}
