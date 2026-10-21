// Placeholder (TODO-style declared-but-missing path) behaviour.
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
    std::snprintf(suffix, sizeof(suffix), "iaqs-holder-%08x", rd());
    path = fs::temp_directory_path() / suffix;
    fs::create_directories(path);
  }
  ~TempDir() {
    std::error_code ec;
    fs::remove_all(path, ec);
  }
};

void write_text(const fs::path& file, std::string_view text) {
  fs::create_directories(file.parent_path());
  write_file(file.string(), bytes_span(text));
}

bool contains(const std::vector<std::string>& items, std::string_view value) {
  for (const auto& item : items) {
    if (item == value) return true;
  }
  return false;
}

}  // namespace

IAQS_TEST(placeholder, declare_list_and_remove) {
  TempDir tmp;
  vcs::Repo repo = vcs::Repo::init(tmp.path, "pw");

  repo.add_placeholder("docs/future.md", "not implemented yet");
  const auto items = repo.list_placeholders();
  CHECK_EQ(items.size(), std::size_t{1});
  CHECK_EQ(items[0].path, std::string("docs/future.md"));
  CHECK_EQ(items[0].reason, std::string("not implemented yet"));

  const vcs::StatusReport report = repo.status();
  CHECK_EQ(report.placeholders_pending.size(), std::size_t{1});
  CHECK(contains(report.placeholders_pending, "docs/future.md"));
  CHECK(!report.clean());

  CHECK(repo.remove_placeholder("docs/future.md"));
  CHECK(!repo.remove_placeholder("docs/future.md"));
  CHECK(repo.list_placeholders().empty());
  CHECK(repo.status().placeholders_pending.empty());
}

IAQS_TEST(placeholder, staging_the_real_file_fulfils_it) {
  TempDir tmp;
  vcs::Repo repo = vcs::Repo::init(tmp.path, "pw");
  repo.add_placeholder("src/feature.cpp", "waiting for the design");

  write_text(tmp.path / "src" / "feature.cpp", "int main() { return 0; }\n");
  const vcs::StatusReport before = repo.status();
  CHECK_EQ(before.placeholders_pending.size(), std::size_t{0});  // file exists now

  repo.add_paths({"src/feature.cpp"}, false);
  CHECK(repo.list_placeholders().empty());
  CHECK(contains(repo.status().staged_added, "src/feature.cpp"));
}

IAQS_TEST(placeholder, existing_file_is_rejected) {
  TempDir tmp;
  vcs::Repo repo = vcs::Repo::init(tmp.path, "pw");
  write_text(tmp.path / "real.txt", "here\n");
  CHECK_THROW(repo.add_placeholder("real.txt", "should not work"), std::runtime_error);
}

IAQS_TEST(placeholder, outside_path_is_rejected) {
  TempDir tmp;
  vcs::Repo repo = vcs::Repo::init(tmp.path / "repo", "pw");
  CHECK_THROW(repo.add_placeholder("../escape.txt", "nope"), std::runtime_error);
}

IAQS_TEST(placeholder, survives_reopen) {
  TempDir tmp;
  {
    vcs::Repo repo = vcs::Repo::init(tmp.path, "pw");
    repo.add_placeholder("vendor/lib.a", "binary not obtained");
    repo.database().close();
  }
  vcs::Repo reopened = vcs::Repo::open(tmp.path, "pw");
  const auto items = reopened.list_placeholders();
  CHECK_EQ(items.size(), std::size_t{1});
  CHECK_EQ(items[0].path, std::string("vendor/lib.a"));
}
