#pragma once

#include <cstddef>
#include <filesystem>
#include <string>
#include <vector>

#include "vcs/repo.h"

namespace iaqs::git {

using vcs::Repo;

// A uniform identity used when writing git commits/tags, because iaqs history
// deliberately stores no author information.
struct GitIdentity {
  std::string name;
  std::string email;
};

struct PackExportOptions {
  GitIdentity identity{"iaqs", "iaqs@localhost"};
  std::filesystem::path out_dir;  // receives pack-*.pack/.idx plus refs/ and HEAD
  std::size_t max_objects_per_pack = 50000;
};

struct PackExportStats {
  std::size_t packs = 0;
  std::size_t objects = 0;
  std::size_t refs = 0;
};

// Converts the reachable iaqs history into git pack v2 files (one or more) and
// writes git-style refs so the output directory can be used as a git object
// store. Blobs are written as full objects (no deltas).
PackExportStats export_git_packs(Repo& repo, const PackExportOptions& options);

struct GitImportOptions {
  bool force = false;  // allow importing into a non-empty repository
};

struct GitImportStats {
  std::size_t commits = 0;
  std::size_t trees = 0;
  std::size_t blobs = 0;
  std::size_t tags = 0;
  std::size_t refs = 0;
};

// Imports a git directory (`.git`) into `repo`: loose objects and pack files,
// refs/heads/*, refs/tags/* and HEAD. Author identities are dropped (iaqs has
// no authors); committer timestamps are kept.
GitImportStats import_git_dir(Repo& repo, const std::filesystem::path& git_dir,
                              const GitImportOptions& options);

}  // namespace iaqs::git
