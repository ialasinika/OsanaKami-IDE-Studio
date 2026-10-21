#include <cstdio>
#include <filesystem>
#include <fstream>
#include <random>
#include <sstream>
#include <string>

#include "core/util.h"
#include "harness.h"
#include "vcs/export_git.h"
#include "vcs/repo.h"

using namespace iaqs;

namespace {

namespace fs = std::filesystem;

struct TempDir {
  fs::path path;
  TempDir() {
    std::random_device rd;
    char suffix[32];
    std::snprintf(suffix, sizeof(suffix), "iaqs-export-%08x", rd());
    path = fs::temp_directory_path() / suffix;
    fs::create_directories(path);
  }
  ~TempDir() {
    std::error_code ec;
    fs::remove_all(path, ec);
  }
};

void write_text(const fs::path& path, const std::string& text) {
  fs::create_directories(path.parent_path());
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  out.write(text.data(), static_cast<std::streamsize>(text.size()));
}

}  // namespace

IAQS_TEST(export_git, parses_author_identity) {
  vcs::GitAuthor author;
  CHECK(vcs::parse_git_author("Test User <test@example.com>", author));
  CHECK_EQ(author.name, std::string("Test User"));
  CHECK_EQ(author.email, std::string("test@example.com"));
  CHECK(!vcs::parse_git_author("no email", author));
  CHECK(!vcs::parse_git_author("Name <not-an-email>", author));
  CHECK(!vcs::parse_git_author("<test@example.com>", author));
  CHECK(!vcs::parse_git_author("Name <test@example.com", author));
}

IAQS_TEST(export_git, writes_commits_blobs_tags_and_refs) {
  TempDir dir;
  const fs::path root = dir.path / "work";
  fs::create_directories(root);

  std::string second_commit;
  {
    vcs::Repo repo = vcs::Repo::init(root);
    write_text(root / "a.txt", "hello\n");
    write_text(root / "sub" / "b.txt", "world\n");
    repo.add_paths({}, true);
    const std::string first = repo.commit("first commit", false, false);

    write_text(root / "a.txt", "hello again\n");
    fs::remove(root / "sub" / "b.txt");
    repo.rm_paths({"sub/b.txt"}, false);
    repo.add_paths({"a.txt"}, false);
    second_commit = repo.commit("second commit", false, false);
    repo.update_ref("refs/heads/feature", second_commit, "branch: feature");
    repo.create_tag("v1", first, "first release");
    repo.database().close();
  }

  vcs::Repo repo = vcs::Repo::open(root);
  vcs::ExportGitOptions options;
  CHECK(vcs::parse_git_author("Test <test@example.com>", options.author));
  std::ostringstream stream;
  const vcs::ExportGitStats stats = vcs::export_git_fast_import(repo, options, stream);
  repo.database().close();

  const std::string out = stream.str();
  CHECK_EQ(stats.commits, 2u);
  CHECK(stats.blobs >= 2u);
  CHECK_EQ(stats.tags, 1u);
  CHECK_EQ(stats.refs, 2u);

  CHECK(out.find("commit refs/heads/") != std::string::npos);
  CHECK(out.find("author Test <test@example.com>") != std::string::npos);
  CHECK(out.find("committer Test <test@example.com>") != std::string::npos);
  CHECK(out.find("blob\nmark :") != std::string::npos);
  CHECK(out.find("M 100644 :") != std::string::npos);
  CHECK(out.find("D \"sub/b.txt\"") != std::string::npos);
  CHECK(out.find("tag v1\nfrom :") != std::string::npos);
  CHECK(out.find("tagger Test <test@example.com>") != std::string::npos);
  CHECK(out.find("reset refs/heads/main") != std::string::npos);
  CHECK(out.find("reset refs/heads/feature") != std::string::npos);
  CHECK(out.find("reset refs/tags/v1") == std::string::npos);  // annotated: tag command

  // The first commit's tree must not contain the later deletion.
  const std::size_t first_commit = out.find("first commit");
  const std::size_t delete_command = out.find("D \"sub/b.txt\"");
  CHECK(first_commit != std::string::npos);
  CHECK(delete_command != std::string::npos);
  CHECK(delete_command > first_commit);
}

IAQS_TEST(export_git, rejects_invalid_author_without_opening_repo) {
  vcs::GitAuthor author;
  CHECK(!vcs::parse_git_author("", author));
  CHECK(!vcs::parse_git_author("   ", author));
}
