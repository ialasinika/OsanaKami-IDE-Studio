#include "vcs/export_git.h"

#include <algorithm>
#include <cstdio>
#include <memory>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "core/util.h"
#include "vcs/objects.h"
#include "vcs/repo.h"
#include "vcs/store.h"

namespace iaqs::vcs {
namespace {

constexpr const char* kHeadsPrefix = "refs/heads/";
constexpr const char* kTagsPrefix = "refs/tags/";

[[noreturn]] void fail(const std::string& what) {
  throw std::runtime_error("export-git: " + what);
}

void write_data(std::ostream& out, std::string_view bytes) {
  out << "data " << bytes.size() << '\n';
  out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
  out.put('\n');
}

void write_mark(std::ostream& out, std::size_t mark) { out << ':' << mark; }

// git fast-import paths are C-style quoted when they contain spaces, quotes,
// backslashes or control bytes; raw UTF-8 bytes pass through unchanged.
void write_quoted_path(std::ostream& out, const std::string& path) {
  out.put('"');
  for (const unsigned char c : path) {
    switch (c) {
      case '"': out << "\\\""; break;
      case '\\': out << "\\\\"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (c < 0x20) {
          char buffer[8];
          std::snprintf(buffer, sizeof(buffer), "\\%03o", static_cast<unsigned>(c));
          out << buffer;
        } else {
          out.put(static_cast<char>(c));
        }
    }
  }
  out.put('"');
}

std::string octal_mode(uint32_t mode) {
  char buffer[16];
  std::snprintf(buffer, sizeof(buffer), "%o", static_cast<unsigned>(mode));
  return buffer;
}

// Emits a blob object, streaming its payload from the object store so very
// large files never have to be held in memory.
void emit_blob(Repo& repo, std::ostream& out, std::size_t mark, const std::string& oid,
               int64_t raw_size) {
  out << "blob\nmark ";
  write_mark(out, mark);
  out << "\ndata " << raw_size << '\n';
  uint64_t written = 0;
  repo.objects().read_stream(oid, [&](ByteSpan slice) {
    out.write(reinterpret_cast<const char*>(slice.data()),
              static_cast<std::streamsize>(slice.size()));
    written += slice.size();
  });
  if (written != static_cast<uint64_t>(raw_size)) {
    fail("object size mismatch for " + oid);
  }
  out.put('\n');
}

}  // namespace

bool parse_git_author(std::string_view text, GitAuthor& out) {
  const std::string trimmed = trim(text);
  const std::size_t open = trimmed.rfind('<');
  if (open == std::string::npos || trimmed.empty() || trimmed.back() != '>') return false;
  const std::string name = trim(std::string_view(trimmed).substr(0, open));
  const std::string email = trim(std::string_view(trimmed).substr(open + 1, trimmed.size() - open - 2));
  if (name.empty() || email.empty()) return false;
  if (email.find('@') == std::string::npos) return false;
  if (email.find_first_of(" \t\n\r") != std::string::npos) return false;
  out.name = name;
  out.email = email;
  return true;
}

ExportGitStats export_git_fast_import(Repo& repo, const ExportGitOptions& options,
                                      std::ostream& out) {
  ExportGitStats stats;
  const std::string identity = options.author.name + " <" + options.author.email + ">";

  // ---------------------------------------------------------------- refs
  std::vector<std::pair<std::string, std::string>> heads;
  std::vector<std::pair<std::string, std::string>> tags;
  std::vector<std::string> tips;
  for (const auto& [name, oid] : repo.list_refs()) {
    if (starts_with(name, kHeadsPrefix)) {
      heads.emplace_back(name, oid);
      tips.push_back(oid);
    } else if (starts_with(name, kTagsPrefix)) {
      tags.emplace_back(name, oid);
      tips.push_back(repo.peel(oid));
    }
  }
  if (const auto head = repo.head_oid(); head) tips.push_back(*head);

  // ------------------------------------------------- topological commit order
  std::vector<std::string> order;
  std::unordered_set<std::string> emitted;
  std::vector<std::pair<std::string, bool>> stack;
  for (const auto& tip : tips) {
    if (emitted.count(tip)) continue;
    stack.emplace_back(tip, false);
    while (!stack.empty()) {
      const auto [oid, expanded] = stack.back();
      stack.pop_back();
      if (expanded) {
        if (emitted.insert(oid).second) order.push_back(oid);
        continue;
      }
      if (emitted.count(oid)) continue;
      stack.emplace_back(oid, true);
      const Commit commit = repo.read_commit(oid);
      for (auto it = commit.parents.rbegin(); it != commit.parents.rend(); ++it) {
        if (!emitted.count(*it)) stack.emplace_back(*it, false);
      }
    }
  }

  // ------------------------------------------------------------ object sizes
  std::unordered_map<std::string, int64_t> raw_sizes;
  for (const auto& object : repo.objects().list_objects()) {
    raw_sizes.emplace(object.oid, object.raw_size);
  }

  // A temporary branch drives the commit commands; final `reset`s below put the
  // real branches/tags in place, then the temporary ref is deleted.
  std::string vehicle = "refs/heads/iaqs-export";
  for (int suffix = 1; std::any_of(heads.begin(), heads.end(),
                                   [&](const auto& head) { return head.first == vehicle; });
       ++suffix) {
    vehicle = "refs/heads/iaqs-export-" + std::to_string(suffix);
  }

  std::unordered_map<std::string, std::size_t> commit_marks;
  std::unordered_map<std::string, std::size_t> blob_marks;
  std::unordered_map<std::string, std::vector<std::string>> tree_paths;
  std::size_t next_mark = 1;

  auto blob_mark_for = [&](const std::string& oid) -> std::size_t {
    const auto existing = blob_marks.find(oid);
    if (existing != blob_marks.end()) return existing->second;
    const auto size = raw_sizes.find(oid);
    if (size == raw_sizes.end()) fail("missing object " + oid);
    const std::size_t mark = next_mark++;
    emit_blob(repo, out, mark, oid, size->second);
    blob_marks.emplace(oid, mark);
    ++stats.blobs;
    return mark;
  };
  auto paths_of_tree = [&](const std::string& tree_oid) -> const std::vector<std::string>& {
    const auto existing = tree_paths.find(tree_oid);
    if (existing != tree_paths.end()) return existing->second;
    std::vector<std::string> paths;
    for (const auto& entry : repo.flatten_tree(tree_oid)) paths.push_back(entry.path);
    std::sort(paths.begin(), paths.end());
    return tree_paths.emplace(tree_oid, std::move(paths)).first->second;
  };

  for (const auto& oid : order) {
    const Commit commit = repo.read_commit(oid);
    const std::size_t mark = next_mark++;
    commit_marks.emplace(oid, mark);

    std::vector<IndexEntry> entries = repo.flatten_tree(commit.tree);
    std::sort(entries.begin(), entries.end(),
              [](const IndexEntry& a, const IndexEntry& b) { return a.path < b.path; });

    // Blob commands are top-level fast-import objects and must be emitted
    // before the commit block that references them.
    std::vector<std::size_t> entry_marks;
    entry_marks.reserve(entries.size());
    for (const auto& entry : entries) entry_marks.push_back(blob_mark_for(entry.oid));

    out << "commit " << vehicle << '\n';
    out << "mark ";
    write_mark(out, mark);
    out << "\nauthor " << identity << ' ' << commit.time << ' ' << commit.tz << '\n';
    out << "committer " << identity << ' ' << commit.time << ' ' << commit.tz << '\n';
    write_data(out, commit.message);

    if (!commit.parents.empty()) {
      out << "from ";
      write_mark(out, commit_marks.at(commit.parents.front()));
      out << '\n';
      for (std::size_t i = 1; i < commit.parents.size(); ++i) {
        out << "merge ";
        write_mark(out, commit_marks.at(commit.parents[i]));
        out << '\n';
      }
    }

    // Files removed relative to the first parent need explicit D commands.
    if (!commit.parents.empty()) {
      const std::string& parent_tree = repo.read_commit(commit.parents.front()).tree;
      const auto& parent_paths = paths_of_tree(parent_tree);
      std::unordered_set<std::string> current_paths;
      current_paths.reserve(entries.size());
      for (const auto& entry : entries) current_paths.insert(entry.path);
      for (const auto& path : parent_paths) {
        if (current_paths.count(path) == 0) {
          out << "D ";
          write_quoted_path(out, path);
          out.put('\n');
        }
      }
    }

    for (std::size_t i = 0; i < entries.size(); ++i) {
      if (entries[i].mode == kModeDir) continue;
      out << "M " << octal_mode(entries[i].mode) << ' ';
      write_mark(out, entry_marks[i]);
      out.put(' ');
      write_quoted_path(out, entries[i].path);
      out.put('\n');
    }
    out.put('\n');
    ++stats.commits;
  }

  // ------------------------------------------------------------------ tags
  for (const auto& [ref, oid] : tags) {
    const std::string name = ref.substr(std::string(kTagsPrefix).size());
    const std::string target = repo.peel(oid);
    const auto target_mark = commit_marks.find(target);
    if (target_mark == commit_marks.end()) continue;  // unreachable/non-commit target
    const ObjType type = repo.objects().type_of(oid);
    if (type == ObjType::Tag) {
      const Tag tag = decode_tag(repo.objects().read(oid));
      out << "tag " << name << "\nfrom ";
      write_mark(out, target_mark->second);
      out << "\ntagger " << identity << ' ' << tag.time << ' ' << tag.tz << '\n';
      write_data(out, tag.message);
    } else {
      out << "reset " << ref << "\nfrom ";
      write_mark(out, target_mark->second);
      out << "\n\n";
    }
    ++stats.tags;
  }

  // -------------------------------------------------------------- branches
  for (const auto& [ref, oid] : heads) {
    const auto mark = commit_marks.find(repo.peel(oid));
    if (mark == commit_marks.end()) continue;
    out << "reset " << ref << "\nfrom ";
    write_mark(out, mark->second);
    out << "\n\n";
    ++stats.refs;
  }

  // Delete the helper branch: all commits stay reachable from the resets above.
  out << "reset " << vehicle << "\n\n";
  out.flush();
  if (!out) fail("failed while writing the fast-import stream");
  return stats;
}

}  // namespace iaqs::vcs
