// Export an iaqs repository as a git fast-import stream.
//
// iaqs commits carry no author identity (single-user, local history), while git
// requires one. `--author "Name <email>"` supplies the identity that is stamped
// on every exported commit and tag.
//
// Supported output format: `fast-import` (default). The stream contains blobs,
// commits (with marks, so the DAG including merges is preserved), annotated
// tags, and final resets for every git branch ref. It can be consumed with:
//
//   iaqs export-git --author "Test <t@example.com>" | git fast-import
//
// Only the graph reachable from branch tips, HEAD and tag targets is exported;
// the object database's delta/chunk layout is flattened back into plain blobs.
#pragma once

#include <cstddef>
#include <cstdint>
#include <ostream>
#include <string>
#include <string_view>

namespace iaqs::vcs {

class Repo;

struct GitAuthor {
  std::string name;
  std::string email;
};

// Parses `Name <email>` (whitespace trimmed, email must contain '@').
bool parse_git_author(std::string_view text, GitAuthor& out);

struct ExportGitOptions {
  GitAuthor author;
};

struct ExportGitStats {
  std::size_t commits = 0;
  std::size_t blobs = 0;
  std::size_t tags = 0;
  std::size_t refs = 0;
};

// Writes the fast-import stream to `out`. Throws std::runtime_error on a
// corrupted repository (missing objects / malformed commits).
ExportGitStats export_git_fast_import(Repo& repo, const ExportGitOptions& options,
                                      std::ostream& out);

}  // namespace iaqs::vcs
