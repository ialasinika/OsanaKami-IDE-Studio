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
    std::snprintf(suffix, sizeof(suffix), "iaqs-repo-%08x", rd());
    path = fs::temp_directory_path() / suffix;
    fs::create_directories(path);
  }
  ~TempDir() {
    std::error_code ec;
    fs::remove_all(path, ec);
  }
};

std::string read_text(const fs::path& file) {
  return read_file(file.string());
}

void write_text(const fs::path& file, std::string_view text) {
  write_file(file.string(), bytes_span(text));
}

std::string first_line(std::string_view message) {
  const std::size_t eol = message.find('\n');
  return std::string(message.substr(0, eol));
}

}  // namespace

IAQS_TEST(vcs_repo, tag_lifecycle) {
  TempDir tmp;
  vcs::Repo repo = vcs::Repo::init(tmp.path, "pw");
  write_text(tmp.path / "a.txt", "one\n");
  repo.add_paths({"a.txt"}, false);
  const std::string commit_oid = repo.commit("base", false, false);

  const std::string tag_oid = repo.create_tag("v1", "HEAD", "release one");
  CHECK_EQ(tag_oid.size(), std::size_t{64});
  CHECK_EQ(repo.peel(tag_oid), commit_oid);

  const auto tags = repo.list_tags();
  CHECK_EQ(tags.size(), std::size_t{1});
  CHECK_EQ(tags[0].name, std::string("v1"));
  CHECK_EQ(tags[0].object, commit_oid);

  repo.delete_tag("v1");
  CHECK_EQ(repo.list_tags().size(), std::size_t{0});
  CHECK_THROW(repo.resolve("refs/tags/v1"), std::runtime_error);
  repo.database().close();
}

IAQS_TEST(vcs_repo, reset_hard_restores_tree_and_branch) {
  TempDir tmp;
  vcs::Repo repo = vcs::Repo::init(tmp.path, "pw");
  write_text(tmp.path / "a.txt", "one\n");
  repo.add_paths({"a.txt"}, false);
  const std::string first = repo.commit("c1", false, false);

  write_text(tmp.path / "a.txt", "two\n");
  repo.add_paths({"a.txt"}, false);
  repo.commit("c2", false, false);

  write_text(tmp.path / "a.txt", "dirty\n");
  repo.reset_hard("HEAD^");

  CHECK_EQ(read_text(tmp.path / "a.txt"), std::string("one\n"));
  const std::string head = repo.peel(*repo.head_oid());
  CHECK_EQ(head, first);
  CHECK_EQ(first_line(repo.read_commit(head).message), std::string("c1"));
  CHECK(repo.status().clean());
  repo.database().close();
}

IAQS_TEST(vcs_repo, merge_keeps_one_sided_additions) {
  TempDir tmp;
  vcs::Repo repo = vcs::Repo::init(tmp.path, "pw");
  write_text(tmp.path / "base.txt", "base\n");
  repo.add_paths({"base.txt"}, false);
  const std::string base = repo.commit("base", false, false);
  repo.update_ref("refs/heads/feature", base, "branch: created");
  repo.set_head_symbolic("refs/heads/feature");

  write_text(tmp.path / "feature.txt", "from feature\n");
  repo.add_paths({"feature.txt"}, false);
  repo.commit("feature side", false, false);

  repo.set_head_symbolic("refs/heads/main");
  write_text(tmp.path / "main.txt", "from main\n");
  repo.add_paths({"main.txt"}, false);
  repo.commit("main side", false, false);

  const vcs::Repo::MergeOutcome outcome = repo.merge("feature");
  CHECK_EQ(outcome.kind, vcs::Repo::MergeOutcome::Kind::Merged);
  CHECK(outcome.conflicts.empty());
  CHECK_EQ(read_text(tmp.path / "main.txt"), std::string("from main\n"));
  CHECK_EQ(read_text(tmp.path / "feature.txt"), std::string("from feature\n"));
  CHECK(repo.status().clean());
  repo.database().close();
}

IAQS_TEST(vcs_repo, change_password_reopens_with_new_password) {
  TempDir tmp;
  {
    vcs::Repo repo = vcs::Repo::init(tmp.path, "first");
    write_text(tmp.path / "a.txt", "content\n");
    repo.add_paths({"a.txt"}, false);
    repo.commit("only", false, false);
    repo.change_password("second");
    repo.database().close();
  }
  CHECK_THROW(vcs::Repo::open(tmp.path, "first"), std::runtime_error);
  {
    vcs::Repo repo = vcs::Repo::open(tmp.path, "second");
    const std::string head = repo.peel(*repo.head_oid());
    CHECK_EQ(first_line(repo.read_commit(head).message), std::string("only"));
    repo.database().close();
  }
}

// Regression: a path such as "../outside.txt" used to leave the worktree and
// even delete files outside the repository through rm/restore.
IAQS_TEST(vcs_repo, rejects_paths_outside_the_worktree) {
  TempDir tmp;
  const fs::path root = tmp.path / "repo";
  fs::create_directories(root);
  vcs::Repo repo = vcs::Repo::init(root, "pw");
  write_text(tmp.path / "outside.txt", "outside\n");
  write_text(root / "inside.txt", "inside\n");

  CHECK_THROW(repo.add_paths({"../outside.txt"}, false), std::runtime_error);
  CHECK_THROW(repo.add_paths({"..\\outside.txt"}, false), std::runtime_error);
  CHECK_THROW(repo.rm_paths({"../outside.txt"}, false), std::runtime_error);
  CHECK_THROW(repo.restore_paths({"../outside.txt"}), std::runtime_error);
  CHECK_THROW(repo.mv_path("../outside.txt", "moved.txt"), std::runtime_error);
  // The file outside the repository is untouched.
  CHECK_EQ(read_text(tmp.path / "outside.txt"), std::string("outside\n"));

  // Absolute paths inside the repository keep working.
  repo.add_paths({(root / "inside.txt").string()}, false);
  const std::string commit_oid = repo.commit("base", false, false);
  CHECK_EQ(commit_oid.size(), std::size_t{64});
  CHECK_EQ(read_text(root / "inside.txt"), std::string("inside\n"));
  repo.database().close();
}

// Regression: staging the encrypted database files themselves used to be
// possible; restoring an old .iaqs/MANIFEST after a rekey irrecoverably
// breaks the repository.
IAQS_TEST(vcs_repo, refuses_repository_internals) {
  TempDir tmp;
  vcs::Repo repo = vcs::Repo::init(tmp.path, "pw");
  write_text(tmp.path / "a.txt", "a\n");
  repo.add_paths({"a.txt"}, false);
  repo.commit("base", false, false);

  CHECK_THROW(repo.add_paths({".iaqs/MANIFEST"}, false), std::runtime_error);
  CHECK_THROW(repo.add_paths({".iaqs/seg-000000.dat"}, false), std::runtime_error);
  CHECK_THROW(repo.rm_paths({".iaqs/MANIFEST"}, false), std::runtime_error);
  CHECK_THROW(repo.mv_path(".iaqs/MANIFEST", "manifest.txt"), std::runtime_error);
  // The database is still openable and the index is untouched.
  CHECK(repo.status().clean());
  repo.database().close();
}
