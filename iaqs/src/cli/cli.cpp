#include "cli/cli.h"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <string>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#else
#include <unistd.h>
#endif

#include "core/util.h"
#include "db/database.h"
#include "i18n/i18n.h"
#include "vcs/diff.h"
#include "vcs/export_git.h"
#include "git/convert.h"
#include "vcs/linediff.h"
#include "vcs/repo.h"

namespace iaqs::cli {
namespace {

namespace fs = std::filesystem;
using i18n::Msg;

// All command-line paths are UTF-8; never construct fs::path from a narrow
// string directly (that would use the ANSI code page on Windows).
fs::path path_arg(const std::string& text) { return fs_path_from_utf8(text); }

int usage_error(const std::string& message) {
  std::cerr << i18n::tr(Msg::ErrorUsage, {message}) << "\n";
  return 2;
}

bool stdout_is_terminal() {
#if defined(_WIN32)
  return _isatty(_fileno(stdout)) != 0;
#else
  return isatty(1) != 0;
#endif
}

// Turns on ANSI escape handling in the Windows console (no-op elsewhere).
void enable_virtual_terminal() {
#if defined(_WIN32)
  HANDLE handle = GetStdHandle(STD_OUTPUT_HANDLE);
  if (handle == INVALID_HANDLE_VALUE || handle == nullptr) return;
  DWORD mode = 0;
  if (GetConsoleMode(handle, &mode)) {
    SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
  }
#endif
}

// Adds ANSI colors to unified-diff lines (+ green, - red, @@ cyan, headers
// bold) and leaves every other byte untouched.
std::string colorize_diff(std::string_view diff) {
  std::string out;
  out.reserve(diff.size() + diff.size() / 8);
  size_t pos = 0;
  while (pos < diff.size()) {
    const size_t newline = diff.find('\n', pos);
    const size_t end = newline == std::string_view::npos ? diff.size() : newline + 1;
    const std::string_view line = diff.substr(pos, end - pos);
    const char* code = nullptr;
    if (line.rfind("+++", 0) == 0 || line.rfind("---", 0) == 0) {
      code = "\x1b[1m";
    } else if (line.rfind("@@", 0) == 0) {
      code = "\x1b[36m";
    } else if (!line.empty() && line[0] == '+') {
      code = "\x1b[32m";
    } else if (!line.empty() && line[0] == '-') {
      code = "\x1b[31m";
    }
    if (code != nullptr) out += code;
    out += line;
    if (code != nullptr) out += "\x1b[0m";
    pos = end;
  }
  return out;
}

struct ParsedArgs {
  std::vector<std::string> positional;
  std::map<std::string, std::string> options;
  std::vector<std::string> rest;
};

int open_error(const std::string& message) {
  if (message.find("password") != std::string::npos) {
    std::cerr << i18n::tr(Msg::ErrorPassword) << "\n";
    return 4;
  }
  std::cerr << "iaqs: " << message << "\n";
  return 1;
}

const char* mode_text(uint32_t mode) {
  switch (mode) {
    case vcs::kModeExec: return "100755";
    case vcs::kModeSymlink: return "120000";
    case vcs::kModeDir: return "040000";
    default: return "100644";
  }
}

std::string short_oid(const std::string& oid) { return oid.substr(0, 12); }

void print_status(const vcs::StatusReport& report, vcs::Repo& repo, bool porcelain) {
  if (porcelain) {
    for (const auto& p : report.staged_added) std::cout << "A  " << p << "\n";
    for (const auto& p : report.staged_modified) std::cout << "M  " << p << "\n";
    for (const auto& p : report.staged_deleted) std::cout << "D  " << p << "\n";
    for (const auto& p : report.modified) std::cout << " M " << p << "\n";
    for (const auto& p : report.deleted) std::cout << " D " << p << "\n";
    for (const auto& p : report.untracked) std::cout << "?? " << p << "\n";
    for (const auto& p : report.placeholders_pending) std::cout << "P  " << p << "\n";
    return;
  }
  const std::string branch = repo.head_ref();
  std::cout << i18n::tr(Msg::OnBranch,
                        {branch.empty() ? i18n::tr(Msg::OnDetached)
                                        : branch.substr(11)})
            << "\n";
  bool any = false;
  auto section = [&](const std::string& title, const std::vector<std::string>& items) {
    if (items.empty()) return;
    any = true;
    std::cout << title << "\n";
    for (const auto& item : items) std::cout << "  " << item << "\n";
  };
  section(i18n::tr(Msg::StatusStaged), report.staged_added);
  section(i18n::tr(Msg::StatusStaged), report.staged_modified);
  section(i18n::tr(Msg::StatusStaged), report.staged_deleted);
  section(i18n::tr(Msg::StatusUnstaged), report.modified);
  section(i18n::tr(Msg::StatusUnstaged), report.deleted);
  section(i18n::tr(Msg::StatusUntracked), report.untracked);
  section(i18n::tr(Msg::StatusPlaceholders), report.placeholders_pending);
  if (!any) std::cout << i18n::tr(Msg::StatusClean) << "\n";
}

ParsedArgs parse_args(const std::vector<std::string>& args,
                      const std::vector<std::string>& valued = {}) {
  ParsedArgs out;
  for (size_t i = 0; i < args.size(); ++i) {
    const std::string& arg = args[i];
    bool matched = false;
    if (arg == "--") {
      for (size_t j = i + 1; j < args.size(); ++j) out.rest.push_back(args[j]);
      break;
    }
    for (const auto& name : valued) {
      if ((arg == "--" + name || arg == "-" + name) && i + 1 < args.size()) {
        out.options[name] = args[++i];
        matched = true;
        break;
      }
    }
    if (matched) continue;
    // --name=value form (shell-safe, no separate token needed).
    if (arg.size() > 2 && arg[0] == '-') {
      const size_t equals = arg.find('=');
      if (equals != std::string::npos) {
        const size_t prefix = arg.rfind("--", 0) == 0 ? 2 : 1;
        const std::string name = arg.substr(prefix, equals - prefix);
        if (!name.empty()) {
          out.options[name] = arg.substr(equals + 1);
          continue;
        }
      }
    }
    if (arg.size() > 1 && arg[0] == '-') {
      size_t skip = arg.rfind("--", 0) == 0 ? 2 : 1;
      out.options[arg.substr(skip)] = "1";
    } else {
      out.positional.push_back(arg);
    }
  }
  return out;
}

int cmd_init(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"lang", "repo"});
  fs::path dir = fs::current_path();
  if (!parsed.positional.empty()) {
    const std::string& path = parsed.positional.back();
    const auto u8 = reinterpret_cast<const char8_t*>(path.data());
    dir = fs::path(std::u8string(u8, path.size()));
  }
  try {
    vcs::Repo repo = vcs::Repo::init(dir, std::string());
    std::cout << i18n::tr(Msg::InitCreated, {fs_path_to_utf8(dir)}) << "\n";
    repo.database().close();
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_add(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang"});
  const std::string repo_path = parsed.options.count("repo") ? parsed.options.at("repo") : "";
  fs::path root;
  try {
    root = vcs::Repo::find_root(repo_path.empty() ? fs::current_path() : path_arg(repo_path));
  } catch (const std::exception&) {
    std::cerr << i18n::tr(Msg::ErrorNotRepo) << "\n";
    return 1;
  }
  const std::string password = std::string();
  try {
    vcs::Repo repo = vcs::Repo::open(root, password);
    const bool all = parsed.options.count("A") || parsed.options.count("all");
    repo.add_paths(parsed.positional, all);
    repo.database().close();
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_status(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang"});
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    print_status(repo.status(), repo, parsed.options.count("porcelain") > 0);
    repo.database().close();
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_commit(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"message", "m", "repo", "lang"});
  std::string message;
  if (parsed.options.count("m")) message = parsed.options.at("m");
  if (parsed.options.count("message")) message = parsed.options.at("message");
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    const bool allow_empty = parsed.options.count("allow-empty") > 0;
    const bool amend = parsed.options.count("amend") > 0;
    const std::string oid = repo.commit(message, allow_empty, amend);
    std::cout << i18n::tr(Msg::Committed, {oid.substr(0, 12)}) << "\n";
    repo.database().close();
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_log(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang", "n"});
  size_t limit = 20;
  if (parsed.options.count("n")) limit = static_cast<size_t>(std::stoul(parsed.options.at("n")));
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    const bool oneline = parsed.options.count("oneline") > 0;
    for (const auto& entry : repo.log(limit, parsed.options.count("all") > 0)) {
      const std::string first_line =
          entry.commit.message.substr(0, entry.commit.message.find('\n'));
      if (oneline) {
        std::cout << short_oid(entry.oid) << " " << first_line << "\n";
      } else {
        std::cout << "commit " << entry.oid << "\n";
        if (!entry.commit.parents.empty()) {
          std::cout << "parents";
          for (const auto& parent : entry.commit.parents) std::cout << " " << parent;
          std::cout << "\n";
        }
        std::cout << "time   " << vcs::format_time(entry.commit.time, entry.commit.tz) << " "
                  << entry.commit.tz << "\n\n";
        std::cout << "    " << entry.commit.message << "\n";
      }
    }
    repo.database().close();
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_show(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang"});
  if (parsed.positional.empty()) return usage_error("show needs a revision");
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    const std::string oid = repo.resolve(parsed.positional[0]);
    const vcs::Commit commit = repo.read_commit(oid);
    std::cout << "commit " << oid << "\n";
    std::cout << "tree   " << commit.tree << "\n";
    for (const auto& parent : commit.parents) std::cout << "parent " << parent << "\n";
    std::cout << "time   " << vcs::format_time(commit.time, commit.tz) << " " << commit.tz << "\n\n";
    std::cout << "    " << commit.message << "\n";
    repo.database().close();
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_cat_file(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang"});
  if (parsed.positional.empty()) return usage_error("cat-file needs a revision");
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    std::string object = repo.resolve(parsed.positional[0]);
    auto& store = repo.objects();
    if (parsed.positional.size() > 1) {
      // Resolve a path inside a tree-ish.
      if (store.type_of(object) == vcs::ObjType::Commit) {
        object = repo.read_commit(object).tree;
      }
      const std::string& path = parsed.positional[1];
      size_t start = 0;
      while (true) {
        const size_t slash = path.find('/', start);
        const std::string want = path.substr(start, slash == std::string::npos ? std::string::npos
                                                                              : slash - start);
        bool found = false;
        for (const auto& entry : repo.read_tree(object)) {
          if (entry.name != want) continue;
          object = entry.oid;
          found = true;
          break;
        }
        if (!found) return open_error("path not found: " + path);
        if (slash == std::string::npos) break;
        start = slash + 1;
      }
    }
    vcs::ObjType type = vcs::ObjType::Blob;
    const Bytes payload = store.read(object, &type);
    std::cout.write(payload.data(), static_cast<std::streamsize>(payload.size()));
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_ls_tree(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang"});
  const std::string rev = parsed.positional.empty() ? "HEAD" : parsed.positional[0];
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    const std::string oid = repo.resolve(rev);
    std::string tree = oid;
    if (repo.objects().type_of(oid) == vcs::ObjType::Commit) tree = repo.read_commit(oid).tree;
    for (const auto& entry : repo.flatten_tree(tree)) {
      std::cout << mode_text(entry.mode) << " blob " << entry.oid << "\t" << entry.path << "\n";
    }
    repo.database().close();
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_branch(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang"});
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    const std::string head = repo.head_ref();
    if (parsed.positional.empty()) {
      const auto rows = repo.database().scan_rows("refs");
      for (const auto& [rid, row] : rows) {
        if (row.values.size() < 2) continue;
        const std::string name = row.values[0].bytes;
        if (name.rfind("refs/heads/", 0) != 0) continue;
        std::cout << (name == head ? "* " : "  ") << name.substr(11) << "\n";
      }
      repo.database().close();
      return 0;
    }
    const std::string name = parsed.positional[0];
    std::string start;
    if (parsed.positional.size() > 1) {
      start = repo.resolve(parsed.positional[1]);
    } else if (const auto current = repo.head_oid()) {
      start = *current;
    } else {
      return open_error("unborn branch has no commit to branch from");
    }
    if (repo.ref_oid("refs/heads/" + name)) return open_error("branch already exists: " + name);
    repo.database().begin();
    try {
      repo.update_ref("refs/heads/" + name, start, "branch: created");
      repo.database().commit();
      std::cout << i18n::tr(Msg::BranchCreated,
                            {name, start.substr(0, 12)}) << "\n";
    } catch (...) {
      repo.database().rollback();
      throw;
    }
    repo.database().close();
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_switch(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang"});
  if (parsed.positional.empty()) return usage_error("switch needs a branch or revision");
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    const std::string target = parsed.positional[0];
    // One code path for branches and revisions: checkout_commit refuses to
    // overwrite local changes unless --force, so switching can never silently
    // discard staged or modified work.
    repo.checkout_commit(target, parsed.options.count("force") > 0);
    const std::string branch_ref = "refs/heads/" + target;
    if (repo.ref_oid(branch_ref)) {
      repo.database().begin();
      try {
        repo.set_head_symbolic(branch_ref);
        repo.database().commit();
      } catch (...) {
        repo.database().rollback();
        throw;
      }
    }
    std::cout << i18n::tr(Msg::CheckoutDone, {target}) << "\n";
    repo.database().close();
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}


int cmd_merge(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang"});
  if (parsed.positional.empty()) return usage_error("merge needs a branch or revision");
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    const vcs::Repo::MergeOutcome outcome = repo.merge(parsed.positional[0]);
    switch (outcome.kind) {
      case vcs::Repo::MergeOutcome::Kind::UpToDate:
        std::cout << i18n::tr(Msg::MergeUpToDate) << "\n";
        break;
      case vcs::Repo::MergeOutcome::Kind::FastForward:
        std::cout << i18n::tr(Msg::MergeFastForward, {short_oid(outcome.commit_oid)})
                  << "\n";
        break;
      case vcs::Repo::MergeOutcome::Kind::Merged:
        std::cout << i18n::tr(Msg::MergeCommit, {short_oid(outcome.commit_oid)}) << "\n";
        break;
      case vcs::Repo::MergeOutcome::Kind::Conflicted:
        std::cout << i18n::tr(Msg::MergeConflicts,
                              {std::to_string(outcome.conflicts.size())})
                  << "\n";
        for (const auto& path : outcome.conflicts) std::cout << "  " << path << "\n";
        std::cout << i18n::tr(Msg::MergeResolveHint) << "\n";
        repo.database().close();
        return 1;
    }
    repo.database().close();
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_info(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang"});
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    const std::string head = repo.head_ref();
    const auto oid = repo.head_oid();
    std::cout << i18n::tr(Msg::RepoInfo, {fs_path_to_utf8(root)}) << "\n";
    std::cout << i18n::tr(Msg::InfoHead, {head.empty() ? "(detached)" : head}) << "\n";
    std::cout << i18n::tr(Msg::InfoCommit, {oid ? *oid : "(unborn)"}) << "\n";
    std::cout << i18n::tr(Msg::InfoPageSize,
                          {std::to_string(repo.database().manifest().page_size)})
              << "\n";
    std::string tables;
    for (const auto& name : repo.database().table_names()) {
      if (!tables.empty()) tables += " ";
      tables += name;
    }
    std::cout << i18n::tr(Msg::InfoTables, {tables}) << "\n";
    repo.database().close();
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_gc(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang"});
  const bool dry_run = parsed.options.count("dry-run") || parsed.options.count("n") > 0;
  const bool full = parsed.options.count("full") > 0;
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    vcs::Repo::GcOptions options;
    options.dry_run = dry_run;
    options.full = full;
    const vcs::Repo::GcStats stats = repo.gc(options);
    std::cout << i18n::tr(dry_run ? Msg::GcWouldRepack : Msg::GcRepacked)
              << i18n::tr(Msg::GcSummary,
                          {std::to_string(stats.objects_scanned),
                           std::to_string(stats.deltas_written),
                           std::to_string(stats.objects_removed),
                           std::to_string(stats.bytes_before),
                           std::to_string(stats.bytes_after),
                           std::to_string(stats.saved_bytes())})
              << "\n";
    if (stats.incremental && !dry_run) {
      std::cout << i18n::tr(Msg::GcKeptDeltas,
                            {std::to_string(stats.deltas_kept),
                             std::to_string(stats.candidate_objects)})
                << "\n";
    }
    repo.database().close();
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_fsck(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang"});
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    const vcs::Repo::FsckReport report = repo.fsck();
    std::cout << i18n::tr(Msg::FsckChecked,
                          {std::to_string(report.objects),
                           std::to_string(report.commits),
                           std::to_string(report.trees),
                           std::to_string(report.blobs),
                           std::to_string(report.tags)})
              << "\n";
    for (const auto& error : report.errors) {
      std::cout << i18n::tr(Msg::FsckError, {error}) << "\n";
    }
    repo.database().close();
    if (!report.ok()) {
      std::cout << i18n::tr(Msg::FsckProblems,
                            {std::to_string(report.errors.size())})
                << "\n";
      return 1;
    }
    std::cout << i18n::tr(Msg::FsckOk) << "\n";
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_rm(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang"});
  if (parsed.positional.empty()) return usage_error("rm needs at least one path");
  const bool cached = parsed.options.count("cached") > 0 || parsed.options.count("C") > 0;
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    repo.rm_paths(parsed.positional, cached);
    repo.database().close();
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_mv(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang"});
  if (parsed.positional.size() != 2) return usage_error("mv needs <from> and <to>");
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    repo.mv_path(parsed.positional[0], parsed.positional[1]);
    repo.database().close();
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_restore(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang"});
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    // Restoring without paths reverts the whole tree; that is destructive, so it
    // requires an explicit --all (previously it silently reverted everything).
    if (parsed.positional.empty() && parsed.options.count("all") == 0) {
      repo.database().close();
      return usage_error("restore needs paths or --all to revert the whole worktree");
    }
    const std::size_t restored = repo.restore_paths(parsed.positional);
    if (!parsed.positional.empty() && restored == 0) {
      repo.database().close();
      return usage_error("restore matched no tracked path");
    }
    std::cout << i18n::tr(Msg::RestorePaths,
                          {parsed.positional.empty() ? std::string("*")
                                                     : std::to_string(restored)})
              << "\n";
    repo.database().close();
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_clean(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang"});
  const bool dry_run = parsed.options.count("dry-run") > 0 || parsed.options.count("n") > 0;
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    const auto removed = repo.clean_untracked(dry_run);
    for (const auto& path : removed) std::cout << (dry_run ? "would remove " : "removed ") << path << "\n";
    std::cout << (dry_run ? "Would remove " : "Removed ") << removed.size()
              << " untracked file(s).\n";
    repo.database().close();
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_rev_parse(const std::vector<std::string>& args) {
  // --short[=N]: abbreviate the resolved object id (default 8 hex chars).
  size_t short_len = 0;
  std::vector<std::string> filtered;
  for (const auto& arg : args) {
    if (arg == "--short" || arg == "-short") {
      short_len = 8;
      continue;
    }
    if (arg.rfind("--short=", 0) == 0) {
      const std::string digits = arg.substr(8);
      bool ok = !digits.empty() && digits.size() <= 2;
      size_t value = 0;
      for (char c : digits) {
        if (c < '0' || c > '9') ok = false;
        value = value * 10 + static_cast<size_t>(c - '0');
      }
      if (!ok || value < 4 || value > 64) {
        return usage_error("--short expects a length between 4 and 64");
      }
      short_len = value;
      continue;
    }
    filtered.push_back(arg);
  }
  const ParsedArgs parsed = parse_args(filtered, {"repo", "lang"});
  const std::string rev = parsed.positional.empty() ? "HEAD" : parsed.positional[0];
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    const std::string oid = repo.resolve(rev);
    if (short_len > 0 && oid.size() > short_len) {
      std::cout << oid.substr(0, short_len) << "\n";
    } else {
      std::cout << oid << "\n";
    }
    repo.database().close();
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_checkpoint(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang"});
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    repo.database().checkpoint();
    std::cout << i18n::tr(Msg::CheckpointDone) << "\n";
    repo.database().close();
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

std::string tree_of_rev(vcs::Repo& repo, std::string_view rev) {
  const std::string oid = repo.peel(repo.resolve(rev));
  if (repo.objects().type_of(oid) == vcs::ObjType::Commit) {
    return repo.read_commit(oid).tree;
  }
  return oid;
}

std::map<std::string, Bytes> tree_contents(vcs::Repo& repo,
                                           const std::string& tree_oid) {
  std::map<std::string, Bytes> files;
  for (const auto& entry : repo.flatten_tree(tree_oid)) {
    if (entry.mode == vcs::kModeDir) continue;
    files[entry.path] = repo.objects().read(entry.oid);
  }
  return files;
}

std::map<std::string, Bytes> worktree_contents(vcs::Repo& repo) {
  std::map<std::string, Bytes> files;
  for (const auto& entry : repo.load_index()) {
    const fs::path relative(
        std::u8string(reinterpret_cast<const char8_t*>(entry.path.data()),
                      entry.path.size()));
    const fs::path full = repo.workdir() / relative;
    std::error_code ec;
    if (!fs::is_regular_file(full, ec)) continue;
    const std::u8string u8 = full.u8string();
    files[entry.path] = read_file(std::string(u8.begin(), u8.end()));
  }
  return files;
}

int cmd_diff(const std::vector<std::string>& args) {
  bool stat = false;
  int color_mode = -1;  // -1: auto, 0: never, 1: always
  std::vector<std::string> filtered;
  for (const auto& arg : args) {
    if (arg == "--stat") {
      stat = true;
      continue;
    }
    if (arg == "--no-color" || arg == "--color=never") {
      color_mode = 0;
      continue;
    }
    if (arg == "--color" || arg == "--color=always") {
      color_mode = 1;
      continue;
    }
    if (arg == "--color=auto") {
      color_mode = -1;
      continue;
    }
    filtered.push_back(arg);
  }
  const ParsedArgs parsed = parse_args(filtered, {"repo", "lang"});
  if (parsed.positional.size() > 2) return usage_error("diff takes at most two revisions");
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    std::map<std::string, Bytes> left;
    std::map<std::string, Bytes> right;
    if (parsed.positional.size() == 2) {
      left = tree_contents(repo, tree_of_rev(repo, parsed.positional[0]));
      right = tree_contents(repo, tree_of_rev(repo, parsed.positional[1]));
    } else {
      if (parsed.positional.size() == 1) {
        left = tree_contents(repo, tree_of_rev(repo, parsed.positional[0]));
      } else if (const auto head = repo.head_oid()) {
        left = tree_contents(repo, repo.read_commit(repo.peel(*head)).tree);
      }
      right = worktree_contents(repo);
    }
    const bool color = color_mode == 1 || (color_mode < 0 && stdout_is_terminal());
    if (color) enable_virtual_terminal();
    std::set<std::string> paths;
    for (const auto& [path, content] : left) paths.insert(path);
    for (const auto& [path, content] : right) paths.insert(path);
    size_t changed = 0;
    size_t total_added = 0;
    size_t total_removed = 0;
    for (const auto& path : paths) {
      const Bytes before = left.count(path) ? left[path] : Bytes{};
      const Bytes after = right.count(path) ? right[path] : Bytes{};
      if (before == after) continue;
      ++changed;
      if (vcs::looks_binary(before) || vcs::looks_binary(after)) {
        if (stat) {
          std::cout << path << " | Bin\n";
        } else {
          std::cout << i18n::tr(Msg::DiffBinary, {path}) << "\n";
        }
        continue;
      }
      const auto changes =
          vcs::diff_changes(vcs::split_lines(before), vcs::split_lines(after));
      size_t added = 0;
      size_t removed = 0;
      for (const auto& change : changes) {
        removed += change.end - change.start;
        added += change.lines.size();
      }
      total_added += added;
      total_removed += removed;
      if (stat) {
        std::cout << path << " | " << (added + removed) << " ";
        if (color) std::cout << "\x1b[32m";
        std::cout << std::string(added, '+');
        if (color) std::cout << "\x1b[31m";
        std::cout << std::string(removed, '-');
        if (color) std::cout << "\x1b[0m";
        std::cout << "\n";
      } else {
        const std::string patch =
            vcs::unified_diff(before, after, "a/" + path, "b/" + path);
        std::cout << (color ? colorize_diff(patch) : patch);
      }
    }
    if (stat && changed > 0) {
      std::cout << i18n::tr(Msg::DiffStatSummary,
                            {std::to_string(changed), std::to_string(total_added),
                             std::to_string(total_removed)})
                << "\n";
    }
    repo.database().close();
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_tag(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang", "m", "message"});
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    if (parsed.positional.empty()) {
      for (const auto& tag : repo.list_tags()) {
        std::cout << tag.name << " " << short_oid(tag.object);
        const std::string first_line = tag.message.substr(0, tag.message.find('\n'));
        if (!first_line.empty() && first_line != tag.name) std::cout << " " << first_line;
        std::cout << "\n";
      }
      repo.database().close();
      return 0;
    }
    const std::string& name = parsed.positional[0];
    if (parsed.options.count("d") || parsed.options.count("delete")) {
      repo.delete_tag(name);
      std::cout << i18n::tr(Msg::TagDeleted, {name}) << "\n";
      repo.database().close();
      return 0;
    }
    std::string message;
    if (parsed.options.count("m")) message = parsed.options.at("m");
    if (parsed.options.count("message")) message = parsed.options.at("message");
    const std::string rev =
        parsed.positional.size() > 1 ? parsed.positional[1] : "HEAD";
    const std::string oid = repo.create_tag(name, rev, message);
    std::cout << i18n::tr(Msg::TagCreated, {name, short_oid(oid)}) << "\n";
    repo.database().close();
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_reset(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang"});
  const bool hard = parsed.options.count("hard") > 0;
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    const std::string rev = parsed.positional.empty() ? std::string("HEAD")
                                                     : parsed.positional[0];
    if (!hard) {
      repo.database().close();
      return usage_error("reset currently requires --hard");
    }
    repo.reset_hard(rev);
    const std::string oid = repo.peel(*repo.head_oid());
    const vcs::Commit commit = repo.read_commit(oid);
    std::cout << i18n::tr(Msg::ResetDone,
                          {short_oid(oid),
                           commit.message.substr(0, commit.message.find('\n'))})
              << "\n";
    repo.database().close();
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_placeholder(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang", "m", "message"});
  const std::string action = parsed.positional.empty() ? "list" : parsed.positional[0];
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    if (action == "list" || action == "ls") {
      const auto items = repo.list_placeholders();
      if (items.empty()) {
        std::cout << i18n::tr(Msg::PlaceholderNone) << "\n";
      } else {
        std::cout << i18n::tr(Msg::PlaceholderListHeader) << "\n";
        for (const auto& item : items) {
          std::cout << "  " << item.path;
          if (!item.reason.empty()) std::cout << "  " << item.reason;
          std::cout << "\n";
        }
      }
    } else if (action == "add") {
      if (parsed.positional.size() < 2) return usage_error("placeholder add needs a path");
      std::string reason;
      if (parsed.options.count("m")) reason = parsed.options.at("m");
      if (parsed.options.count("message")) reason = parsed.options.at("message");
      const std::string path = parsed.positional[1];
      repo.add_placeholder(path, reason);
      std::cout << i18n::tr(Msg::PlaceholderAdded, {path}) << "\n";
    } else if (action == "remove" || action == "rm" || action == "delete") {
      if (parsed.positional.size() < 2) return usage_error("placeholder remove needs a path");
      const std::string path = parsed.positional[1];
      if (!repo.remove_placeholder(path)) {
        return usage_error("no such placeholder: " + path);
      }
      std::cout << i18n::tr(Msg::PlaceholderRemoved, {path}) << "\n";
    } else {
      return usage_error("unknown placeholder action: " + action);
    }
    repo.database().close();
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

std::string find_language(const ParsedArgs& parsed) {
  if (parsed.options.count("lang")) return parsed.options.at("lang");
  return {};
}

// Reads `--name value` or `--name=value` from the raw argument list (git-style
// long options with '=' are not covered by parse_args' spaced form).
std::string long_option(const std::vector<std::string>& args, std::string_view name) {
  const std::string spaced = "--" + std::string(name);
  const std::string with_equals = spaced + "=";
  for (size_t i = 0; i < args.size(); ++i) {
    if (args[i] == spaced) {
      if (i + 1 < args.size()) return args[i + 1];
      return {};
    }
    if (starts_with(args[i], with_equals)) return args[i].substr(with_equals.size());
  }
  return {};
}

int cmd_export_git(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang", "author", "format", "out"});
  std::string author_option = long_option(args, "author");
  if (author_option.empty() && parsed.options.count("author")) {
    author_option = parsed.options.at("author");
  }
  if (author_option.empty()) {
    return usage_error("export-git requires --author \"Name <email>\"");
  }
  vcs::GitAuthor author;
  if (!vcs::parse_git_author(author_option, author)) {
    return usage_error("invalid --author, expected \"Name <email>\"");
  }
  std::string format = long_option(args, "format");
  if (format.empty() && parsed.options.count("format")) format = parsed.options.at("format");
  if (format.empty()) format = "fast-import";
  const bool pack_format = format == "pack";
  if (format != "fast-import" && !pack_format) {
    return usage_error("unsupported --format '" + format +
                       "' (use fast-import or pack)");
  }
  std::string out_dir = long_option(args, "out");
  if (out_dir.empty() && parsed.options.count("out")) out_dir = parsed.options.at("out");
  if (pack_format && out_dir.empty()) {
    return usage_error("export-git --format=pack requires --out <directory>");
  }
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    if (pack_format) {
      git::PackExportOptions options;
      options.identity.name = author.name;
      options.identity.email = author.email;
      options.out_dir = path_arg(out_dir);
      const git::PackExportStats stats = git::export_git_packs(repo, options);
      repo.database().close();
      std::cerr << i18n::tr(Msg::ExportPackDone,
                            {std::to_string(stats.packs), std::to_string(stats.objects),
                             std::to_string(stats.refs)})
                << "\n";
      return 0;
    }
    vcs::ExportGitOptions options;
    options.author = author;
#ifdef _WIN32
    // stdout is opened in text mode, which would translate every '\n' into
    // "\r\n" and break the fast-import stream for consumers like git.
    const int previous_mode = _setmode(_fileno(stdout), _O_BINARY);
#endif
    const vcs::ExportGitStats stats = vcs::export_git_fast_import(repo, options, std::cout);
    std::cout.flush();
#ifdef _WIN32
    if (previous_mode != -1) _setmode(_fileno(stdout), previous_mode);
#endif
    repo.database().close();
    std::cerr << i18n::tr(Msg::ExportGitDone,
                          {std::to_string(stats.commits), std::to_string(stats.blobs),
                           std::to_string(stats.tags), std::to_string(stats.refs)})
              << "\n";
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_import_git(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang"});
  if (parsed.positional.empty()) {
    return usage_error("import-git requires a git directory");
  }
  const std::string source = parsed.positional.back();
  try {
    fs::path root = vcs::Repo::find_root(
        parsed.options.count("repo") ? path_arg(parsed.options.at("repo")) : fs::current_path());
    vcs::Repo repo = vcs::Repo::open(root, std::string());
    git::GitImportOptions options;
    options.force = parsed.options.count("force") != 0;
    const git::GitImportStats stats = git::import_git_dir(repo, path_arg(source), options);
    repo.database().close();
    std::cerr << i18n::tr(Msg::ImportGitDone,
                          {std::to_string(stats.commits), std::to_string(stats.trees),
                           std::to_string(stats.blobs), std::to_string(stats.tags),
                           std::to_string(stats.refs)})
              << "\n";
    return 0;
  } catch (const std::exception& error) {
    return open_error(error.what());
  }
}

int cmd_lang(const std::vector<std::string>& args) {
  const ParsedArgs parsed = parse_args(args, {"repo", "lang"});
  const std::string action =
      parsed.positional.empty() ? "list" : parsed.positional[0];
  if (action == "list" || action == "ls") {
    std::cout << i18n::tr(Msg::LangListHeader) << "\n";
    for (const i18n::LanguageInfo& info : i18n::available_languages()) {
      std::cout << "  " << info.code << "\t"
                << (info.name.empty() ? info.code : info.name);
      if (info.builtin) {
        std::cout << "\t[builtin]";
      } else {
        std::cout << "\t" << info.path;
      }
      if (info.code == i18n::language()) std::cout << "\t*";
      std::cout << "\n";
    }
    return 0;
  }
  if (action == "install") {
    if (parsed.positional.size() < 2) {
      return usage_error(i18n::tr(Msg::LangUsage));
    }
    std::string error;
    std::string code;
    std::string name;
    if (!i18n::install_language(parsed.positional[1], error, &code, &name)) {
      return usage_error(i18n::tr(Msg::LangInvalidPack, {error}));
    }
    std::cout << i18n::tr(Msg::LangInstalled, {code, name}) << "\n";
    return 0;
  }
  if (action == "remove" || action == "rm") {
    if (parsed.positional.size() < 2) {
      return usage_error(i18n::tr(Msg::LangUsage));
    }
    std::string error;
    const std::string& code = parsed.positional[1];
    if (!i18n::remove_language(code, error)) {
      return usage_error(i18n::tr(Msg::LangNotFound, {code}) + ": " + error);
    }
    std::cout << i18n::tr(Msg::LangRemoved, {code}) << "\n";
    return 0;
  }
  if (action == "use" || action == "set") {
    if (parsed.positional.size() < 2) {
      return usage_error(i18n::tr(Msg::LangUsage));
    }
    const std::string& code = parsed.positional[1];
    if (!i18n::language_exists(code)) {
      return usage_error(i18n::tr(Msg::LangNotFound, {code}));
    }
    std::string error;
    if (!i18n::set_user_language(code, error)) {
      return usage_error(i18n::tr(Msg::LangInvalidPack, {error}));
    }
    i18n::set_language(code);
    std::cout << i18n::tr(Msg::LangDefaultSet, {code}) << "\n";
    return 0;
  }
  if (action == "export") {
    const std::string code =
        parsed.positional.size() > 1 ? parsed.positional[1] : i18n::language();
    if (!i18n::language_exists(code)) {
      return usage_error(i18n::tr(Msg::LangNotFound, {code}));
    }
    std::cout << i18n::export_language(code);
    return 0;
  }
  return usage_error(i18n::tr(Msg::LangUsage));
}

int dispatch(const std::string& command, const std::vector<std::string>& args) {
  if (command == "init") return cmd_init(args);
  if (command == "add") return cmd_add(args);
  if (command == "status") return cmd_status(args);
  if (command == "commit") return cmd_commit(args);
  if (command == "log") return cmd_log(args);
  if (command == "show") return cmd_show(args);
  if (command == "cat-file") return cmd_cat_file(args);
  if (command == "ls-tree") return cmd_ls_tree(args);
  if (command == "branch") return cmd_branch(args);
  if (command == "switch" || command == "checkout") return cmd_switch(args);
  if (command == "merge") return cmd_merge(args);
  if (command == "diff") return cmd_diff(args);
  if (command == "tag") return cmd_tag(args);
  if (command == "reset") return cmd_reset(args);
  if (command == "info") return cmd_info(args);
  if (command == "gc") return cmd_gc(args);
  if (command == "fsck") return cmd_fsck(args);
  if (command == "rm") return cmd_rm(args);
  if (command == "mv") return cmd_mv(args);
  if (command == "restore") return cmd_restore(args);
  if (command == "clean") return cmd_clean(args);
  if (command == "rev-parse") return cmd_rev_parse(args);
  if (command == "checkpoint") return cmd_checkpoint(args);
  if (command == "placeholder") return cmd_placeholder(args);
  if (command == "export-git") return cmd_export_git(args);
  if (command == "import-git") return cmd_import_git(args);
  if (command == "lang") return cmd_lang(args);
  return -1;
}

}  // namespace

int run(int argc, char** argv) {
  std::vector<std::string> args(argv + 1, argv + argc);
  if (!args.empty() && (args[0] == "--version" || args[0] == "-V")) {
    std::cout << i18n::tr(Msg::Version) << "\n";
    return 0;
  }
  if (!args.empty() && (args[0] == "--help" || args[0] == "-h")) {
    std::cout << i18n::tr(Msg::Usage);
    return 0;
  }
  std::string command;
  std::vector<std::string> rest;
  for (size_t i = 0; i < args.size(); ++i) {
    const std::string& arg = args[i];
    if (command.empty() && arg.rfind("-", 0) == 0) {
      // Global options may appear before the command; their values are not
      // commands even when they do not start with '-'.
      const bool takes_value =
          arg == "--lang" || arg == "-lang" || arg == "-l" || arg == "--repo";
      rest.push_back(arg);
      if (takes_value && i + 1 < args.size()) rest.push_back(args[++i]);
      continue;
    }
    if (command.empty()) {
      command = arg;
      continue;
    }
    rest.push_back(arg);
  }

  const ParsedArgs global = parse_args(rest, {"lang", "repo"});
  i18n::detect_language(find_language(global), "");

  if (command.empty() || command == "help" || command == "--help") {
    std::cout << i18n::tr(Msg::Usage);
    return command.empty() ? 2 : 0;
  }
  if (command == "version") {
    std::cout << i18n::tr(Msg::Version) << "\n";
    return 0;
  }

  const int code = dispatch(command, rest);
  if (code < 0) return usage_error("unknown command '" + command + "'");
  return code;
}

}  // namespace iaqs::cli
