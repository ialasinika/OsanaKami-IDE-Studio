#include <cstdio>
#include <filesystem>
#include <random>
#include <string>

#include "core/util.h"
#include "harness.h"
#include "vcs/repo.h"

using namespace iaqs;

namespace {

namespace fs = std::filesystem;

struct TempDir {
  fs::path path;
  TempDir() {
    std::random_device rd;
    char suffix[32];
    std::snprintf(suffix, sizeof(suffix), "iaqs-worktree-%08x", rd());
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

bool index_has(vcs::Repo& repo, std::string_view path) {
  for (const auto& entry : repo.load_index()) {
    if (entry.path == path) return true;
  }
  return false;
}

}  // namespace

IAQS_TEST(vcs_worktree, mv_stages_rename) {
  TempDir tmp;
  vcs::Repo repo = vcs::Repo::init(tmp.path, "pw");
  write_text(tmp.path / "a.txt", "one\n");
  repo.add_paths({"a.txt"}, false);
  repo.commit("base", false, false);

  repo.mv_path("a.txt", "sub/moved.txt");
  CHECK(!fs::exists(tmp.path / "a.txt"));
  CHECK(fs::exists(tmp.path / "sub" / "moved.txt"));
  CHECK(index_has(repo, "sub/moved.txt"));
  CHECK(!index_has(repo, "a.txt"));

  repo.commit("move", false, false);
  CHECK(repo.status().clean());
  repo.database().close();
}

IAQS_TEST(vcs_worktree, restore_brings_back_head_content) {
  TempDir tmp;
  vcs::Repo repo = vcs::Repo::init(tmp.path, "pw");
  write_text(tmp.path / "a.txt", "original\n");
  repo.add_paths({"a.txt"}, false);
  repo.commit("base", false, false);

  write_text(tmp.path / "a.txt", "modified content\n");
  CHECK(!repo.status().clean());
  repo.restore_paths({"a.txt"});
  CHECK_EQ(read_text(tmp.path / "a.txt"), std::string("original\n"));
  CHECK(repo.status().clean());
  repo.database().close();
}

IAQS_TEST(vcs_worktree, rm_deletes_file_and_stages_deletion) {
  TempDir tmp;
  vcs::Repo repo = vcs::Repo::init(tmp.path, "pw");
  write_text(tmp.path / "a.txt", "one\n");
  write_text(tmp.path / "b.txt", "two\n");
  repo.add_paths({"a.txt", "b.txt"}, false);
  repo.commit("base", false, false);

  repo.rm_paths({"a.txt"}, false);
  CHECK(!fs::exists(tmp.path / "a.txt"));
  CHECK(!index_has(repo, "a.txt"));
  CHECK(!repo.status().clean());

  repo.commit("remove a", false, false);
  CHECK(repo.status().clean());

  // --cached: drop from the index but keep the file on disk.
  repo.rm_paths({"b.txt"}, true);
  CHECK(fs::exists(tmp.path / "b.txt"));
  CHECK(!index_has(repo, "b.txt"));
  repo.database().close();
}

IAQS_TEST(vcs_worktree, clean_removes_untracked) {
  TempDir tmp;
  vcs::Repo repo = vcs::Repo::init(tmp.path, "pw");
  write_text(tmp.path / "a.txt", "one\n");
  repo.add_paths({"a.txt"}, false);
  repo.commit("base", false, false);
  write_text(tmp.path / "junk.txt", "junk\n");

  const auto dry = repo.clean_untracked(true);
  CHECK_EQ(dry.size(), std::size_t{1});
  CHECK(fs::exists(tmp.path / "junk.txt"));
  const auto removed = repo.clean_untracked(false);
  CHECK_EQ(removed.size(), std::size_t{1});
  CHECK(!fs::exists(tmp.path / "junk.txt"));
  CHECK(repo.status().clean());
  repo.database().close();
}
