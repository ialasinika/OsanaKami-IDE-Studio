#include <array>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <random>
#include <string>
#include <vector>

#include "core/util.h"
#include "git/convert.h"
#include "git/pack.h"
#include "git/sha1.h"
#include "harness.h"
#include "vcs/repo.h"

using namespace iaqs;
using namespace iaqs::git;

namespace {

namespace fs = std::filesystem;

struct TempDir {
  fs::path path;
  TempDir() {
    std::random_device rd;
    char suffix[32];
    std::snprintf(suffix, sizeof(suffix), "iaqs-gitconv-%08x", rd());
    path = fs::temp_directory_path() / suffix;
    fs::create_directories(path);
  }
  ~TempDir() {
    std::error_code ec;
    fs::remove_all(path, ec);
  }
};

std::string hex_of(const std::array<uint8_t, 20>& id) {
  return to_hex(ByteSpan(id.data(), id.size()));
}

void write_text(const fs::path& path, const std::string& text) {
  fs::create_directories(path.parent_path());
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  out.write(text.data(), static_cast<std::streamsize>(text.size()));
}

// Builds a minimal git directory holding one commit (a.txt = "hello\n"), packed
// with git::write_pack, plus refs/heads/main and HEAD.
fs::path make_git_repo(const fs::path& root) {
  const std::string blob_text = "hello\n";
  const auto blob_id = git_object_id("blob", bytes_span(blob_text));

  Bytes tree_payload;
  tree_payload.append("100644 a.txt");
  tree_payload.push_back('\0');
  tree_payload.append(reinterpret_cast<const char*>(blob_id.data()), 20);
  const auto tree_id = git_object_id("tree", bytes_span(tree_payload));

  const std::string commit_text =
      "tree " + hex_of(tree_id) +
      "\nauthor A <a@example.com> 1700000000 +0800\n"
      "committer A <a@example.com> 1700000000 +0800\n\nhello commit\n";
  const auto commit_id = git_object_id("commit", bytes_span(commit_text));

  const std::vector<git::PackObject> objects = {
      {3, blob_id, Bytes(blob_text)},
      {2, tree_id, tree_payload},
      {1, commit_id, Bytes(commit_text)},
  };
  const fs::path pack_prefix = root / "objects" / "pack" / "pack";
  fs::create_directories(pack_prefix.parent_path());
  (void)git::write_pack(pack_prefix, objects);

  write_text(root / "refs" / "heads" / "main", hex_of(commit_id) + "\n");
  write_text(root / "HEAD", "ref: refs/heads/main\n");
  return root;
}

}  // namespace

IAQS_TEST(import_git, imports_pack_tree_commit_and_ref) {
  TempDir dir;
  const fs::path git_root = make_git_repo(dir.path / "git");
  const fs::path dest = dir.path / "iaqs";
  fs::create_directories(dest);

  vcs::Repo repo = vcs::Repo::init(dest);
  const git::GitImportStats stats = git::import_git_dir(repo, git_root, {});
  CHECK_EQ(stats.commits, 1u);
  CHECK_EQ(stats.trees, 1u);
  CHECK_EQ(stats.blobs, 1u);
  CHECK_EQ(stats.refs, 1u);

  const auto head = repo.head_oid();
  CHECK(head.has_value());
  CHECK_EQ(repo.head_ref(), std::string("refs/heads/main"));
  const vcs::Commit commit = repo.read_commit(*head);
  CHECK_EQ(commit.time, int64_t{1700000000});
  CHECK_EQ(commit.tz, std::string("+0800"));
  CHECK_EQ(commit.message, std::string("hello commit\n"));
  const std::vector<vcs::IndexEntry> entries = repo.flatten_tree(commit.tree);
  CHECK_EQ(entries.size(), 1u);
  CHECK_EQ(entries[0].path, std::string("a.txt"));
  CHECK_EQ(repo.objects().read(entries[0].oid), std::string("hello\n"));
  repo.database().close();
}

IAQS_TEST(import_git, refuses_non_empty_repository_without_force) {
  TempDir dir;
  const fs::path git_root = make_git_repo(dir.path / "git");
  const fs::path dest = dir.path / "iaqs";
  fs::create_directories(dest);
  {
    vcs::Repo repo = vcs::Repo::init(dest);
    (void)git::import_git_dir(repo, git_root, {});
    CHECK_THROW(git::import_git_dir(repo, git_root, {}), std::runtime_error);
    const git::GitImportStats forced = git::import_git_dir(repo, git_root, {.force = true});
    CHECK_EQ(forced.refs, 1u);
    repo.database().close();
  }
}

IAQS_TEST(convert_git, export_then_import_roundtrip) {
  TempDir dir;
  const fs::path source = dir.path / "source";
  fs::create_directories(source);
  std::string committed;
  {
    vcs::Repo repo = vcs::Repo::init(source);
    write_text(source / "docs" / "readme.txt", "round trip\n");
    repo.add_paths({}, true);
    committed = repo.commit("roundtrip commit", false, false);
    repo.create_tag("v1", committed, "first release");
    repo.database().close();
  }

  const fs::path out = dir.path / "git-export";
  {
    vcs::Repo repo = vcs::Repo::open(source);
    git::PackExportOptions options;
    options.identity = {"Test User", "test@example.com"};
    options.out_dir = out;
    const git::PackExportStats stats = git::export_git_packs(repo, options);
    CHECK(stats.packs >= 1);
    CHECK(stats.objects >= 3);
    CHECK_EQ(stats.refs, 2u);  // main + v1
    repo.database().close();
  }
  CHECK(fs::exists(out / "HEAD"));
  CHECK(fs::exists(out / "refs" / "heads" / "main"));
  CHECK(fs::exists(out / "refs" / "tags" / "v1"));

  // Rearrange the exported packs into a git object directory.
  fs::create_directories(out / "objects" / "pack");
  for (const auto& entry : fs::directory_iterator(out)) {
    const std::string name = entry.path().filename().string();
    if (entry.path().extension() == ".pack" || entry.path().extension() == ".idx") {
      fs::rename(entry.path(), out / "objects" / "pack" / name);
    }
  }

  const fs::path dest = dir.path / "imported";
  fs::create_directories(dest);
  {
    vcs::Repo repo = vcs::Repo::init(dest);
    const git::GitImportStats stats = git::import_git_dir(repo, out, {});
    CHECK_EQ(stats.commits, 1u);
    CHECK_EQ(stats.tags, 1u);
    const auto head = repo.head_oid();
    CHECK(head.has_value());
    CHECK_EQ(repo.read_commit(*head).message, std::string("roundtrip commit\n"));
    const std::vector<vcs::IndexEntry> entries = repo.flatten_tree(repo.read_commit(*head).tree);
    CHECK_EQ(entries.size(), 1u);
    CHECK_EQ(entries[0].path, std::string("docs/readme.txt"));
    CHECK_EQ(repo.objects().read(entries[0].oid), std::string("round trip\n"));
    const auto tag_oid = repo.ref_oid("refs/tags/v1");
    CHECK(tag_oid.has_value());
    CHECK_EQ(repo.peel(*tag_oid), *head);
    repo.database().close();
  }
}
