#include "vcs/repo.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <fstream>
#include <set>
#include <stdexcept>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include "core/util.h"
#include "crypto/sha256.h"
#include "lz/delta.h"
#include "vcs/merge.h"

namespace iaqs::vcs {
namespace {

using db::Row;
using db::TableSchema;
using db::Value;
using db::ValueType;

namespace fs = std::filesystem;

[[noreturn]] void fail(const std::string& what) {
  throw std::runtime_error("repo: " + what);
}

std::string u8(const fs::path& p) {
  const std::u8string s = p.u8string();
  return std::string(reinterpret_cast<const char*>(s.data()), s.size());
}

fs::path from_u8(std::string_view s) {
  return fs::path(std::u8string(reinterpret_cast<const char8_t*>(s.data()), s.size()));
}

// Symlinks and NTFS junctions are reparse points. Traversing them can leave the
// repository (and `clean` could then delete files outside it), so scans skip
// them entirely.
bool is_reparse_point(const fs::path& path) {
#if defined(_WIN32)
  const DWORD attributes = GetFileAttributesW(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES &&
         (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
#else
  std::error_code ec;
  return fs::is_symlink(fs::symlink_status(path, ec));
#endif
}

// The .iaqs directory (at any depth) holds the encrypted database itself and
// must never enter the index, a tree or the worktree materialisation.
bool path_is_repo_internal(std::string_view path) {
  std::size_t start = 0;
  while (true) {
    const std::size_t slash = path.find('/', start);
    const std::string_view part =
        path.substr(start, slash == std::string_view::npos ? std::string_view::npos
                                                           : slash - start);
    if (part == ".iaqs") return true;
    if (slash == std::string_view::npos) return false;
    start = slash + 1;
  }
}

// Rejects ref names that could escape the namespace (path traversal, control
// characters, git-incompatible bytes). iaqs stores refs in the database, but
// every export path (git fast-import / pack) puts them on disk, so the name
// must stay a single safe component chain.
bool valid_ref_name(std::string_view name) {
  if (name.empty() || name.front() == '-' || name.back() == '/' ||
      name.back() == '.') {
    return false;
  }
  if (name.find("//") != std::string_view::npos ||
      name.find("..") != std::string_view::npos ||
      name.find("@{") != std::string_view::npos ||
      (name.size() >= 5 && name.substr(name.size() - 5) == ".lock")) {
    return false;
  }
  for (const unsigned char byte : name) {
    if (byte < 0x20 || byte == 0x7f) return false;
    if (std::string_view(" ~^:?*[\\").find(static_cast<char>(byte)) !=
        std::string_view::npos) {
      return false;
    }
  }
  return true;
}

// Maps a user-supplied path to a repository-relative path and refuses anything
// that resolves outside the worktree ("..", another drive, a symlink that
// escapes, ...). Every command that reads, writes or deletes worktree files
// must go through this.
std::string repo_relative_inside(const fs::path& workdir, std::string_view raw) {
  const fs::path raw_path = from_u8(raw);
  const fs::path target = raw_path.is_absolute() ? raw_path : workdir / raw_path;
  std::error_code ec;
  fs::path root = fs::weakly_canonical(workdir, ec);
  if (ec) root = workdir.lexically_normal();
  fs::path resolved = fs::weakly_canonical(target, ec);
  if (ec) resolved = target.lexically_normal();
  const fs::path rel = resolved.lexically_relative(root);
  std::string text = u8(rel);
  std::replace(text.begin(), text.end(), '\\', '/');
  if (rel.empty() || rel == "." || rel.is_absolute() || text == ".." ||
      text.rfind("../", 0) == 0) {
    fail("path is outside the repository: " + std::string(raw));
  }
  if (path_is_repo_internal(text)) {
    fail("refusing to touch repository internals: " + std::string(raw));
  }
  return text;
}

// Computes the blob object id of a file without loading it into memory.
std::string hash_blob_file(const fs::path& path) {
  const uint64_t size = static_cast<uint64_t>(fs::file_size(path));
  Sha256 hasher;
  std::string header("blob ");
  header += std::to_string(size);
  header += '\0';
  hasher.update(header);
  std::ifstream in(path, std::ios::binary);
  if (!in) fail("cannot read " + u8(path));
  std::vector<uint8_t> buffer(65536);
  while (in) {
    in.read(reinterpret_cast<char*>(buffer.data()),
            static_cast<std::streamsize>(buffer.size()));
    const std::streamsize got = in.gcount();
    if (got <= 0) break;
    hasher.update(ByteSpan(buffer.data(), static_cast<size_t>(got)));
  }
  const std::array<uint8_t, 32> digest = hasher.finish();
  return to_hex(ByteSpan(digest.data(), digest.size()));
}

const std::string kZeroOid(64, '0');

bool is_hex(std::string_view s) {
  if (s.empty()) return false;
  for (char c : s) {
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

// Simple gitignore-subset globbing over '/'-separated relative paths.
bool glob_match(std::string_view pat, std::string_view text) {
  while (!pat.empty()) {
    if (pat == "**") return true;
    if (pat.size() >= 3 && pat.substr(0, 3) == "**/") {
      const std::string_view rest = pat.substr(3);
      if (glob_match(rest, text)) return true;
      for (size_t i = 0; i < text.size(); ++i) {
        if (text[i] == '/' && glob_match(rest, text.substr(i + 1))) return true;
      }
      return false;
    }
    switch (pat[0]) {
      case '*': {
        const std::string_view rest = pat.substr(1);
        if (glob_match(rest, text)) return true;
        for (size_t i = 0; i < text.size() && text[i] != '/'; ++i) {
          if (glob_match(rest, text.substr(i + 1))) return true;
        }
        return false;
      }
      case '?':
        if (text.empty() || text[0] == '/') return false;
        pat.remove_prefix(1);
        text.remove_prefix(1);
        break;
      case '\\':
        if (pat.size() > 1) pat.remove_prefix(1);
        [[fallthrough]];
      default:
        if (text.empty() || pat[0] != text[0]) return false;
        pat.remove_prefix(1);
        text.remove_prefix(1);
        break;
    }
  }
  return text.empty();
}

// Evaluates .iaqsignore (last matching rule wins, '!' negates a match).
bool ignored_by_rules(const fs::path& root, std::string_view rel, bool is_dir) {
  const fs::path ignore_file = root / ".iaqsignore";
  if (!fs::exists(ignore_file)) return false;
  Bytes content;
  try {
    content = read_file(u8(ignore_file));
  } catch (...) {
    return false;
  }
  bool ignored = false;
  for (const std::string_view raw : split(content, '\n')) {
    std::string_view line = trim(raw);
    if (line.empty() || line[0] == '#') continue;
    bool negate = false;
    if (line[0] == '!') {
      negate = true;
      line.remove_prefix(1);
    }
    if (line.empty()) continue;
    bool dir_only = line.back() == '/';
    if (dir_only) line.remove_suffix(1);
    if (line.empty()) continue;
    if (line[0] == '/') line.remove_prefix(1);

    bool matched = false;
    if (line.find('/') == std::string_view::npos) {
      // Match any path component.
      size_t start = 0;
      while (start <= rel.size()) {
        size_t end = rel.find('/', start);
        if (end == std::string_view::npos) end = rel.size();
        if (glob_match(line, rel.substr(start, end - start))) {
          matched = true;
          break;
        }
        if (end == rel.size()) break;
        start = end + 1;
      }
    } else {
      matched = glob_match(line, rel);
    }
    if (matched && dir_only && !is_dir) {
      matched = false;
      // A directory rule also ignores everything below the directory.
      matched = rel.size() > line.size() && rel.substr(0, line.size()) == line &&
                rel[line.size()] == '/';
      if (!matched && line.size() + 1 <= rel.size()) {
        const std::string prefix = std::string(line) + "/";
        matched = rel.substr(0, prefix.size()) == prefix;
      }
    }
    if (matched) ignored = negate ? false : true;
  }
  return ignored;
}

TableSchema make_schema(std::string name,
                        std::vector<std::pair<std::string, ValueType>> cols) {
  TableSchema schema;
  schema.name = std::move(name);
  for (auto& [cname, ctype] : cols) {
    db::ColumnDef def;
    def.name = cname;
    def.type = ctype;
    if (cname == "name" || cname == "key" || cname == "path" || cname == "ref") {
      def.primary_key = true;
      def.not_null = true;
    }
    schema.columns.push_back(std::move(def));
  }
  return schema;
}

}  // namespace

int64_t now_seconds() {
  return static_cast<int64_t>(std::time(nullptr));
}

std::string local_tz() {
  const std::time_t now = std::time(nullptr);
  std::tm local{};
  std::tm utc{};
#if defined(_WIN32)
  localtime_s(&local, &now);
  gmtime_s(&utc, &now);
#else
  localtime_r(&now, &local);
  gmtime_r(&now, &utc);
#endif
  int diff_min = (local.tm_hour - utc.tm_hour) * 60 + (local.tm_min - utc.tm_min);
  diff_min += (local.tm_yday - utc.tm_yday) * 24 * 60;
  const char sign = diff_min < 0 ? '-' : '+';
  const int abs_min = diff_min < 0 ? -diff_min : diff_min;
  char buf[8];
  std::snprintf(buf, sizeof(buf), "%c%02d%02d", sign, abs_min / 60, abs_min % 60);
  return std::string(buf);
}

std::string format_time(int64_t ts, std::string_view tz) {
  int offset_min = 0;
  if (tz.size() == 5 && (tz[0] == '+' || tz[0] == '-')) {
    offset_min = (tz[1] - '0') * 600 + (tz[2] - '0') * 60 + (tz[3] - '0') * 10 +
                 (tz[4] - '0');
    if (tz[0] == '-') offset_min = -offset_min;
  }
  const std::time_t shifted = static_cast<std::time_t>(ts + offset_min * 60LL);
  std::tm tm{};
#if defined(_WIN32)
  gmtime_s(&tm, &shifted);
#else
  gmtime_r(&shifted, &tm);
#endif
  char buf[32];
  std::snprintf(buf, sizeof(buf), "%04d-%02d-%02d %02d:%02d", tm.tm_year + 1900,
                tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min);
  return std::string(buf);
}

fs::path Repo::find_root(const fs::path& start) {
  fs::path current = fs::absolute(start);
  for (int depth = 0; depth < 64; ++depth) {
    if (fs::exists(current / ".iaqs")) return current;
    if (!current.has_parent_path() || current.parent_path() == current) break;
    current = current.parent_path();
  }
  fail("not inside a repository (no .iaqs directory found)");
}

Repo::Repo(std::filesystem::path workdir, db::Database database,
           std::string_view password)
    : workdir_(std::move(workdir)), db_(std::move(database)), store_(db_),
      password_(password) {}

Repo Repo::init(const fs::path& workdir, std::string_view password) {
  fs::create_directories(workdir);
  const fs::path iaqs = fs::absolute(workdir) / ".iaqs";
  auto database = db::Database::create(u8(iaqs), password);
  Repo repo(fs::absolute(workdir), std::move(database), password);
  repo.ensure_schema();
  repo.set_default_config();
  repo.database().begin();
  try {
    repo.set_head_symbolic("refs/heads/main");
    repo.database().commit();
  } catch (...) {
    repo.database().rollback();
    throw;
  }
  return repo;
}

Repo Repo::open(const fs::path& workdir, std::string_view password) {
  const fs::path iaqs = fs::absolute(workdir) / ".iaqs";
  if (!fs::exists(iaqs / "MANIFEST")) fail("no repository database at " + u8(iaqs));
  auto database = db::Database::open(u8(iaqs), password);
  Repo repo(fs::absolute(workdir), std::move(database), password);
  repo.ensure_schema();
  return repo;
}

void Repo::ensure_schema() {
  store_.ensure_schema();
  db_.begin();
  if (!db_.table_exists("refs")) {
    db_.create_table(make_schema("refs", {{"name", ValueType::Text}, {"oid", ValueType::Text}}));
  }
  if (!db_.table_exists("meta")) {
    db_.create_table(make_schema("meta", {{"key", ValueType::Text}, {"value", ValueType::Blob}}));
  }
  if (!db_.table_exists("reflog")) {
    db_.create_table(make_schema("reflog", {{"ref", ValueType::Text},
                                           {"seq", ValueType::Integer},
                                           {"old_oid", ValueType::Text},
                                           {"new_oid", ValueType::Text},
                                           {"ts", ValueType::Integer},
                                           {"tz", ValueType::Text},
                                           {"message", ValueType::Text}}));
  }
  if (!db_.table_exists("index_entries")) {
    db_.create_table(make_schema("index_entries", {{"path", ValueType::Text},
                                                   {"mode", ValueType::Integer},
                                                   {"oid", ValueType::Text},
                                                   {"size", ValueType::Integer},
                                                   {"mtime_ns", ValueType::Integer}}));
  }
  if (!db_.table_exists("merge_state")) {
    db_.create_table(make_schema("merge_state", {{"path", ValueType::Text},
                                                 {"base_oid", ValueType::Text},
                                                 {"ours_oid", ValueType::Text},
                                                 {"theirs_oid", ValueType::Text}}));
  }
  if (!db_.table_exists("placeholders")) {
    db_.create_table(make_schema("placeholders", {{"path", ValueType::Text},
                                                  {"reason", ValueType::Text},
                                                  {"created_ts", ValueType::Integer}}));
  }
  if (!db_.table_exists("config")) {
    db_.create_table(make_schema("config", {{"key", ValueType::Text}, {"value", ValueType::Text}}));
  }
  db_.commit();
}

void Repo::set_default_config() {
  db_.begin();
  config_set("default_branch", "main");
  config_set("db.page_size", std::to_string(db_.manifest().page_size));
  config_set("diff.context", "3");
  config_set("ui.lang", "auto");
  config_set("ui.color", "auto");
  db_.commit();
}

std::string Repo::config_get(std::string_view key, std::string_view fallback) const {
  const auto rows = const_cast<db::Database&>(db_).scan_rows("config");
  for (const auto& [rid, row] : rows) {
    if (row.values.size() >= 2 && row.values[0].type == ValueType::Text &&
        row.values[0].bytes == std::string(key)) {
      return row.values[1].bytes;
    }
  }
  return std::string(fallback);
}

void Repo::config_set(std::string_view key, std::string_view value) {
  const auto rows = db_.scan_rows("config");
  for (const auto& [rid, row] : rows) {
    if (row.values.size() >= 2 && row.values[0].type == ValueType::Text &&
        row.values[0].bytes == std::string(key)) {
      Row updated;
      updated.values = {Value::text(Bytes(key)), Value::text(Bytes(value))};
      db_.update_row("config", rid, updated);
      return;
    }
  }
  Row row;
  row.values = {Value::text(Bytes(key)), Value::text(Bytes(value))};
  db_.insert_row("config", row);
}

std::optional<std::string> Repo::ref_oid(std::string_view name) {
  const auto rows = db_.scan_rows("refs");
  for (const auto& [rid, row] : rows) {
    if (row.values.size() >= 2 && row.values[0].type == ValueType::Text &&
        row.values[0].bytes == std::string(name) && row.values[1].type == ValueType::Text) {
      return row.values[1].bytes;
    }
  }
  return std::nullopt;
}

std::string Repo::head_ref() {
  const auto rows = db_.scan_rows("meta");
  for (const auto& [rid, row] : rows) {
    if (row.values.size() >= 2 && row.values[0].type == ValueType::Text &&
        row.values[0].bytes == "HEAD" && row.values[1].type == ValueType::Blob) {
      const std::string value = row.values[1].bytes;
      if (value.rfind("ref: ", 0) == 0) return value.substr(5);
      return {};  // detached
    }
  }
  return {};
}

std::optional<std::string> Repo::head_oid() {
  const std::string ref = head_ref();
  if (ref.empty()) {
    const auto rows = db_.scan_rows("meta");
    for (const auto& [rid, row] : rows) {
      if (row.values.size() >= 2 && row.values[0].type == ValueType::Text &&
          row.values[0].bytes == "HEAD" && row.values[1].type == ValueType::Blob) {
        const std::string value = row.values[1].bytes;
        if (value.size() == 64 && is_hex(value)) return value;
      }
    }
    return std::nullopt;
  }
  return ref_oid(ref);
}

void Repo::set_head_symbolic(std::string_view ref) {
  const auto rows = db_.scan_rows("meta");
  for (const auto& [rid, row] : rows) {
    if (row.values.size() >= 2 && row.values[0].type == ValueType::Text &&
        row.values[0].bytes == "HEAD") {
      Row updated;
      updated.values = {Value::text(Bytes("HEAD")), Value::blob(Bytes("ref: " + std::string(ref)))};
      db_.update_row("meta", rid, updated);
      return;
    }
  }
  Row row;
  row.values = {Value::text(Bytes("HEAD")), Value::blob(Bytes("ref: " + std::string(ref)))};
  db_.insert_row("meta", row);
}

void Repo::set_head_detached(const std::string& oid) {
  if (oid.size() != 64 || !is_hex(oid)) fail("set_head_detached: bad object id");
  const auto rows = db_.scan_rows("meta");
  for (const auto& [rid, row] : rows) {
    if (row.values.size() >= 2 && row.values[0].type == ValueType::Text &&
        row.values[0].bytes == "HEAD") {
      Row updated;
      updated.values = {Value::text(Bytes("HEAD")), Value::blob(Bytes(oid))};
      db_.update_row("meta", rid, updated);
      return;
    }
  }
  Row row;
  row.values = {Value::text(Bytes("HEAD")), Value::blob(Bytes(oid))};
  db_.insert_row("meta", row);
}

void Repo::update_ref(std::string_view name, const std::string& oid,
                      std::string_view message) {
  if (!valid_ref_name(name)) fail("invalid ref name: " + std::string(name));
  const std::string old_oid = ref_oid(name).value_or(kZeroOid);
  const auto rows = db_.scan_rows("refs");
  bool updated = false;
  for (const auto& [rid, row] : rows) {
    if (row.values.size() >= 2 && row.values[0].type == ValueType::Text &&
        row.values[0].bytes == std::string(name)) {
      Row next;
      next.values = {Value::text(Bytes(name)), Value::text(Bytes(oid))};
      db_.update_row("refs", rid, next);
      updated = true;
      break;
    }
  }
  if (!updated) {
    Row row;
    row.values = {Value::text(Bytes(name)), Value::text(Bytes(oid))};
    db_.insert_row("refs", row);
  }
  insert_reflog(name, old_oid, oid, message);
}

void Repo::insert_reflog(std::string_view ref, const std::string& old_oid,
                         const std::string& new_oid, std::string_view message) {
  int64_t seq = 1;
  const auto rows = db_.scan_rows("reflog");
  for (const auto& [rid, row] : rows) {
    if (row.values.size() >= 2 && row.values[0].type == ValueType::Text &&
        row.values[0].bytes == std::string(ref)) {
      seq = std::max(seq, row.values[1].int_value + 1);
    }
  }
  Row row;
  row.values = {Value::text(Bytes(ref)), Value::integer(seq),
                Value::text(Bytes(old_oid)), Value::text(Bytes(new_oid)),
                Value::integer(now_seconds()), Value::text(Bytes(current_tz())),
                Value::text(Bytes(message))};
  db_.insert_row("reflog", row);
}

std::string Repo::current_tz() { return local_tz(); }

std::string Repo::peel(std::string_view oid) {
  std::string current(oid);
  for (int depth = 0; depth < 8; ++depth) {
    ObjType type = store_.type_of(current);
    if (type != ObjType::Tag) return current;
    const Tag tag = decode_tag(store_.read(current));
    current = tag.object;
  }
  fail("tag chain too deep");
}

std::string Repo::resolve(std::string_view rev) {
  std::string base(rev);
  std::vector<std::string> steps;
  for (;;) {
    const size_t pos = base.find_last_of("^~");
    if (pos == std::string::npos || pos == 0) break;
    const std::string suffix = base.substr(pos + 1);
    if (!suffix.empty() && !std::all_of(suffix.begin(), suffix.end(),
                                        [](char c) { return c >= '0' && c <= '9'; })) {
      break;
    }
    steps.push_back(base.substr(pos));
    base = base.substr(0, pos);
  }
  std::reverse(steps.begin(), steps.end());

  std::string oid;
  if (base == "HEAD") {
    const auto head = head_oid();
    if (!head) fail("HEAD is unborn (no commits yet)");
    oid = *head;
  } else if (const auto ref = ref_oid(base)) {
    oid = *ref;
  } else if (const auto ref = ref_oid("refs/heads/" + base)) {
    oid = *ref;
  } else if (const auto ref = ref_oid("refs/tags/" + base)) {
    oid = *ref;
  } else if (base.size() >= 4 && base.size() <= 64 && is_hex(base)) {
    const auto rows = db_.scan_rows("objects");
    for (const auto& [rid, row] : rows) {
      if (row.values.size() >= 1 && row.values[0].type == ValueType::Text &&
          row.values[0].bytes.rfind(base, 0) == 0) {
        oid = row.values[0].bytes;
        break;
      }
    }
    if (oid.empty()) fail("unknown revision '" + base + "'");
  } else {
    fail("unknown revision '" + base + "'");
  }

  oid = peel(oid);  // tags resolve to the tagged object for traversals
  for (const auto& step : steps) {
    if (step == "^") {
      const Commit commit = read_commit(oid);
      if (commit.parents.empty()) fail("revision has no parent");
      oid = commit.parents.front();
    } else if (step[0] == '^' && step.size() > 1) {
      const size_t n = std::stoul(step.substr(1));
      const Commit commit = read_commit(oid);
      if (n == 0 || n > commit.parents.size()) fail("revision has no such parent");
      oid = commit.parents[n - 1];
    } else if (step[0] == '~' && step.size() > 1) {
      const size_t n = std::stoul(step.substr(1));
      for (size_t i = 0; i < n; ++i) {
        const Commit commit = read_commit(oid);
        if (commit.parents.empty()) fail("revision has no parent");
        oid = commit.parents.front();
      }
    } else {
      fail("unsupported revision suffix '" + step + "'");
    }
  }
  return oid;
}

std::vector<IndexEntry> Repo::load_index() {
  std::vector<IndexEntry> entries;
  const auto rows = db_.scan_rows("index_entries");
  for (const auto& [rid, row] : rows) {
    if (row.values.size() < 5) continue;
    IndexEntry entry;
    entry.path = row.values[0].bytes;
    if (path_is_repo_internal(entry.path)) continue;
    entry.mode = static_cast<uint32_t>(row.values[1].int_value);
    entry.oid = row.values[2].bytes;
    entry.size = row.values[3].int_value;
    entry.mtime_ns = row.values[4].int_value;
    entries.push_back(std::move(entry));
  }
  std::sort(entries.begin(), entries.end(),
            [](const IndexEntry& a, const IndexEntry& b) { return a.path < b.path; });
  return entries;
}

Bytes Repo::read_blob(const std::string& oid) {
  ObjType type = ObjType::Blob;
  Bytes payload = store_.read(oid, &type);
  if (type != ObjType::Blob) fail("object " + oid + " is not a blob");
  return payload;
}

std::string Repo::write_working_file(const std::string& rel_path) {
  const fs::path path = workdir_ / from_u8(rel_path);
  const uint64_t size = static_cast<uint64_t>(fs::file_size(path));
  if (size <= store_.inline_limit()) {
    const Bytes content = read_file(u8(path));
    return store_.write(ObjType::Blob, content);
  }
  std::ifstream in(path, std::ios::binary);
  if (!in) fail("cannot read " + rel_path);
  return store_.write_stream(ObjType::Blob, size, [&](uint8_t* buffer, size_t capacity) {
    in.read(reinterpret_cast<char*>(buffer), static_cast<std::streamsize>(capacity));
    const std::streamsize got = in.gcount();
    return got > 0 ? static_cast<size_t>(got) : size_t{0};
  });
}

std::vector<IndexEntry> Repo::tracked_files() {
  std::vector<IndexEntry> files;
  const fs::path root = workdir_;
  auto it = fs::recursive_directory_iterator(
      root, fs::directory_options::skip_permission_denied);
  const auto end = fs::recursive_directory_iterator();
  for (; it != end; ++it) {
    // Never descend into reparse points (symlinks / junctions): files behind
    // them belong to other trees, and `clean` could delete data outside the repo.
    if (is_reparse_point(it->path())) {
      if (it->is_directory()) it.disable_recursion_pending();
      continue;
    }
    const std::string name = u8(it->path().filename());
    if (name == ".iaqs" || name.rfind(".dsh-", 0) == 0) {
      if (it->is_directory()) it.disable_recursion_pending();
      continue;
    }
    std::string rel = u8(fs::relative(it->path(), root));
    std::replace(rel.begin(), rel.end(), '\\', '/');
    if (rel.rfind(".iaqs/", 0) == 0) continue;
    if (name.size() >= 10 && name.compare(name.size() - 10, 10, ".iaqs-tmp") == 0) continue;
    if (it->is_directory()) {
      if (ignored_by_rules(root, rel, true)) it.disable_recursion_pending();
      continue;
    }
    if (!it->is_regular_file()) continue;
    if (ignored_by_rules(root, rel, false)) continue;
    IndexEntry entry;
    entry.path = rel;
    files.push_back(std::move(entry));
  }
  std::sort(files.begin(), files.end(),
            [](const IndexEntry& a, const IndexEntry& b) { return a.path < b.path; });
  return files;
}

void Repo::add_paths(const std::vector<std::string>& paths, bool all) {
  db_.begin();
  try {
    std::vector<std::string> targets;
    if (all) {
      for (const auto& entry : tracked_files()) targets.push_back(entry.path);
      // Removals for files that no longer exist.
      for (const auto& entry : load_index()) {
        if (!fs::exists(workdir_ / from_u8(entry.path))) remove_index_path(entry.path);
      }
    } else {
      for (const auto& raw : paths) {
        const fs::path raw_path = from_u8(raw);
        const fs::path abs = raw.empty() ? workdir_
                                        : (raw_path.is_absolute() ? raw_path : workdir_ / raw_path);
        const std::string rel_u8 = raw.empty() ? std::string()
                                               : repo_relative_inside(workdir_, raw);
        if (!fs::exists(abs)) fail("path does not exist: " + raw);
        if (fs::is_directory(abs)) {
          for (auto it = fs::recursive_directory_iterator(
                   abs, fs::directory_options::skip_permission_denied);
               it != fs::recursive_directory_iterator(); ++it) {
            if (is_reparse_point(it->path())) {
              if (it->is_directory()) it.disable_recursion_pending();
              continue;
            }
            if (!it->is_regular_file()) continue;
            const std::string child_rel = repo_relative_inside(workdir_, u8(it->path()));
            if (child_rel.rfind(".iaqs/", 0) == 0) continue;
            if (ignored_by_rules(workdir_, child_rel, false)) continue;
            targets.push_back(child_rel);
          }
        } else {
          targets.push_back(rel_u8);
        }
      }
    }

    std::map<std::string, IndexEntry> existing;
    for (auto& entry : load_index()) existing[entry.path] = std::move(entry);

    for (const auto& target : targets) {
      IndexEntry& entry = existing[target];
      entry.path = target;
      const fs::path abs = workdir_ / from_u8(target);
      entry.mode = kModeFile;
      entry.size = static_cast<int64_t>(fs::file_size(abs));
      entry.mtime_ns = static_cast<int64_t>(
          std::chrono::duration_cast<std::chrono::nanoseconds>(
              fs::last_write_time(abs).time_since_epoch())
              .count());
      entry.oid = write_working_file(target);
      // Staging the real file fulfils a previously declared placeholder.
      remove_placeholder(target);
      std::vector<db::Rid> resolved;
      for (const auto& [rid, row] : db_.scan_rows("merge_state")) {
        if (row.values.size() >= 1 && row.values[0].type == ValueType::Text &&
            row.values[0].bytes == target) {
          resolved.push_back(rid);
        }
      }
      for (const auto& rid : resolved) db_.delete_row("merge_state", rid);
    }

    for (const auto& [path, entry] : existing) {
      (void)path;
      insert_index_entry(entry);
    }
    db_.commit();
  } catch (...) {
    db_.rollback();
    throw;
  }
}

void Repo::insert_index_entry(const IndexEntry& entry) {
  const auto rows = db_.scan_rows("index_entries");
  for (const auto& [rid, row] : rows) {
    if (row.values.size() >= 1 && row.values[0].type == ValueType::Text &&
        row.values[0].bytes == entry.path) {
      Row next;
      next.values = {Value::text(Bytes(entry.path)), Value::integer(entry.mode),
                     Value::text(Bytes(entry.oid)), Value::integer(entry.size),
                     Value::integer(entry.mtime_ns)};
      db_.update_row("index_entries", rid, next);
      return;
    }
  }
  Row row;
  row.values = {Value::text(Bytes(entry.path)), Value::integer(entry.mode),
                Value::text(Bytes(entry.oid)), Value::integer(entry.size),
                Value::integer(entry.mtime_ns)};
  db_.insert_row("index_entries", row);
}

void Repo::remove_index_path(std::string_view path) {
  const auto rows = db_.scan_rows("index_entries");
  for (const auto& [rid, row] : rows) {
    if (row.values.size() >= 1 && row.values[0].type == ValueType::Text &&
        row.values[0].bytes == std::string(path)) {
      db_.delete_row("index_entries", rid);
      return;
    }
  }
}

std::map<std::string, IndexEntry> Repo::head_files() {
  std::map<std::string, IndexEntry> files;
  const auto head = head_oid();
  if (!head) return files;
  const Commit commit = read_commit(*head);
  for (auto& entry : flatten_tree(commit.tree)) files[entry.path] = std::move(entry);
  return files;
}

StatusReport Repo::status() {
  StatusReport report;
  const auto head = head_files();
  const auto index = load_index();
  std::map<std::string, IndexEntry> index_map;
  for (const auto& entry : index) index_map[entry.path] = entry;

  for (const auto& [path, entry] : index_map) {
    const auto it = head.find(path);
    if (it == head.end()) {
      report.staged_added.push_back(path);
    } else if (it->second.oid != entry.oid) {
      report.staged_modified.push_back(path);
    }
  }
  for (const auto& [path, entry] : head) {
    if (index_map.find(path) == index_map.end()) report.staged_deleted.push_back(path);
  }

  const auto on_disk = tracked_files();
  std::set<std::string> disk_paths;
  for (const auto& entry : on_disk) disk_paths.insert(entry.path);

  for (const auto& entry : index) {
    const fs::path abs = workdir_ / from_u8(entry.path);
    if (!fs::exists(abs)) {
      report.deleted.push_back(entry.path);
      continue;
    }
    // The stat cache (size+mtime) is deliberately not trusted here: restoring
    // a timestamp makes a same-size edit look unchanged and would also defeat
    // the checkout/merge dirty guards. Hashing is the only reliable answer.
    const std::string oid = hash_blob_file(abs);
    if (oid != entry.oid) report.modified.push_back(entry.path);
  }

  for (const auto& entry : on_disk) {
    if (index_map.find(entry.path) == index_map.end()) report.untracked.push_back(entry.path);
  }

  // Placeholders whose file has not landed yet stay visible in status.
  for (const auto& placeholder : list_placeholders()) {
    const fs::path abs = workdir_ / from_u8(placeholder.path);
    std::error_code ec;
    if (!fs::exists(abs, ec)) report.placeholders_pending.push_back(placeholder.path);
  }

  auto sort = [](std::vector<std::string>& v) { std::sort(v.begin(), v.end()); };
  sort(report.staged_added);
  sort(report.staged_modified);
  sort(report.staged_deleted);
  sort(report.modified);
  sort(report.deleted);
  sort(report.untracked);
  sort(report.placeholders_pending);
  return report;
}

std::string Repo::tree_from_index(const std::vector<IndexEntry>& entries) {
  struct Node {
    std::map<std::string, Node> dirs;
    std::map<std::string, IndexEntry> files;
  };
  Node root;
  for (const auto& entry : entries) {
    if (path_is_repo_internal(entry.path)) continue;
    Node* node = &root;
    size_t start = 0;
    while (true) {
      const size_t slash = entry.path.find('/', start);
      if (slash == std::string::npos) break;
      node = &node->dirs[entry.path.substr(start, slash - start)];
      start = slash + 1;
    }
    node->files[entry.path.substr(start)] = entry;
  }

  auto build = [&](auto&& self, const Node& node) -> std::string {
    std::vector<TreeEntry> tree;
    for (const auto& [name, entry] : node.files) {
      tree.push_back(TreeEntry{entry.mode, ObjType::Blob, entry.oid, name});
    }
    for (const auto& [name, child] : node.dirs) {
      const std::string child_oid = self(self, child);
      tree.push_back(TreeEntry{kModeDir, ObjType::Tree, child_oid, name});
    }
    return store_.write(ObjType::Tree, encode_tree(tree));
  };
  return build(build, root);
}

std::vector<TreeEntry> Repo::read_tree(const std::string& tree_oid) {
  ObjType type = ObjType::Tree;
  const Bytes payload = store_.read(tree_oid, &type);
  if (type != ObjType::Tree) fail("object " + tree_oid + " is not a tree");
  return decode_tree(payload);
}

std::vector<IndexEntry> Repo::flatten_tree(const std::string& tree_oid,
                                           const std::string& prefix) {
  std::vector<IndexEntry> entries;
  for (const auto& item : read_tree(tree_oid)) {
    if (item.name == ".iaqs") continue;  // never expose repository internals
    const std::string path = prefix + item.name;
    if (item.type == ObjType::Tree) {
      for (auto& child : flatten_tree(item.oid, path + "/")) {
        entries.push_back(std::move(child));
      }
    } else {
      IndexEntry entry;
      entry.path = path;
      entry.mode = item.mode;
      entry.oid = item.oid;
      entries.push_back(std::move(entry));
    }
  }
  return entries;
}

Commit Repo::read_commit(const std::string& commit_oid) {
  ObjType type = ObjType::Commit;
  const Bytes payload = store_.read(commit_oid, &type);
  if (type != ObjType::Commit) fail("object " + commit_oid + " is not a commit");
  return decode_commit(payload);
}

std::string Repo::write_commit(const Commit& commit) {
  return store_.write(ObjType::Commit, encode_commit(commit));
}

std::string Repo::commit(std::string_view message, bool allow_empty, bool amend) {
  db_.begin();
  try {
    const auto index = load_index();
    // A staged entry must point at an object that still exists; otherwise the
    // commit would record a dangling reference (e.g. after a previous gc).
    for (const auto& entry : index) {
      if (!store_.has(entry.oid)) {
        fail("staged object is missing: " + entry.path + " (" + entry.oid + "); run add again");
      }
    }
    const std::string tree = tree_from_index(index);
    const auto head = head_oid();

    Commit commit_data;
    commit_data.tree = tree;
    commit_data.time = now_seconds();
    commit_data.tz = current_tz();

    const bool merging = merge_in_progress();
    if (merging && !db_.scan_rows("merge_state").empty()) {
      fail("cannot commit: unresolved merge conflicts (add each resolved path first)");
    }
    if (amend) {
      if (!head) fail("nothing to amend (unborn branch)");
      const Commit old = read_commit(*head);
      commit_data.parents = old.parents;
      commit_data.message = message.empty() ? old.message : std::string(message);
    } else {
      if (head && merging) {
        const std::string second = meta_get("MERGE_HEAD").value_or("");
        commit_data.parents = {*head, second};
      } else if (head) {
        commit_data.parents = {*head};
      }
      commit_data.message = std::string(message);
      if (head && !allow_empty && !merging) {
        const Commit old = read_commit(*head);
        if (old.tree == tree) fail("nothing to commit (index matches HEAD)");
      }
    }
    if (commit_data.message.empty()) fail("empty commit message");

    const std::string oid = write_commit(commit_data);
    const std::string ref = head_ref();
    if (ref.empty()) {
      // Detached HEAD: move HEAD itself.
      const auto rows = db_.scan_rows("meta");
      for (const auto& [rid, row] : rows) {
        if (row.values.size() >= 2 && row.values[0].type == ValueType::Text &&
            row.values[0].bytes == "HEAD") {
          Row next;
          next.values = {Value::text(Bytes("HEAD")), Value::blob(Bytes(oid))};
          db_.update_row("meta", rid, next);
        }
      }
    } else {
      update_ref(ref, oid, amend ? "commit (amend)" : "commit");
    }
    if (merging) {
      for (const auto& [rid, row] : db_.scan_rows("merge_state")) {
        db_.delete_row("merge_state", rid);
      }
      meta_remove("MERGE_HEAD");
    }
    db_.commit();
    return oid;
  } catch (...) {
    db_.rollback();
    throw;
  }
}

std::vector<LogEntry> Repo::log(size_t max, bool all) {
  std::vector<std::string> tips;
  if (all) {
    const auto rows = db_.scan_rows("refs");
    for (const auto& [rid, row] : rows) {
      if (row.values.size() >= 2 && row.values[1].type == ValueType::Text) {
        tips.push_back(row.values[1].bytes);
      }
    }
  }
  if (const auto head = head_oid()) tips.push_back(*head);

  std::vector<LogEntry> entries;
  std::set<std::string> seen;
  std::vector<std::string> stack;
  // Ref tips can point at annotated tags; log only walks commits.
  for (const auto& tip : tips) {
    if (store_.has(tip) && store_.type_of(tip) == ObjType::Tag) {
      stack.push_back(peel(tip));
    } else {
      stack.push_back(tip);
    }
  }
  while (!stack.empty() && entries.size() < max * 8 + 64) {
    const std::string oid = stack.back();
    stack.pop_back();
    if (!seen.insert(oid).second) continue;
    if (!store_.has(oid) || store_.type_of(oid) != ObjType::Commit) continue;
    LogEntry entry;
    entry.oid = oid;
    entry.commit = read_commit(oid);
    for (const auto& parent : entry.commit.parents) {
      if (!seen.count(parent)) stack.push_back(parent);
    }
    entries.push_back(std::move(entry));
  }
  std::sort(entries.begin(), entries.end(), [](const LogEntry& a, const LogEntry& b) {
    if (a.commit.time != b.commit.time) return a.commit.time > b.commit.time;
    return a.oid < b.oid;
  });
  if (entries.size() > max) entries.resize(max);
  return entries;
}

void Repo::checkout_tree(const std::string& tree_oid) {
  db_.begin();
  try {
    const auto entries = flatten_tree(tree_oid);
    std::set<std::string> wanted;
    for (const auto& entry : entries) {
      wanted.insert(entry.path);
      const fs::path abs = workdir_ / from_u8(entry.path);
      fs::create_directories(abs.parent_path());
      store_.write_to_file(entry.oid, abs);
    }
    for (const auto& entry : load_index()) {
      if (wanted.count(entry.path)) continue;
      const fs::path abs = workdir_ / from_u8(entry.path);
      std::error_code ec;
      fs::remove(abs, ec);
    }
    // Refresh the index to match the tree, clearing old rows.
    const auto rows = db_.scan_rows("index_entries");
    for (const auto& [rid, row] : rows) db_.delete_row("index_entries", rid);
    for (const auto& entry : entries) insert_index_entry(entry);
    db_.commit();
  } catch (...) {
    db_.rollback();
    throw;
  }
}

void Repo::checkout_commit(std::string_view rev, bool force) {
  const std::string oid = resolve(rev);
  const Commit commit = read_commit(oid);
  const auto entries = flatten_tree(commit.tree);
  if (!force) {
    const StatusReport report = status();
    if (!report.staged_added.empty() || !report.staged_modified.empty() ||
        !report.staged_deleted.empty() || !report.modified.empty() ||
        !report.deleted.empty()) {
      fail("working tree has changes; commit or use --force");
    }
    // Untracked files are not covered by status() but must not be overwritten
    // silently by the target tree.
    std::set<std::string> tracked;
    for (const auto& entry : load_index()) tracked.insert(entry.path);
    for (const auto& entry : entries) {
      if (tracked.count(entry.path) != 0) continue;
      const fs::path target = workdir_ / fs_path_from_utf8(entry.path);
      std::error_code ec;
      if (fs::exists(target, ec) && !ec) {
        fail("untracked file would be overwritten by checkout: " + entry.path +
             " (use --force)");
      }
    }
  }
  checkout_tree(commit.tree);
  db_.begin();
  try {
    const auto rows = db_.scan_rows("meta");
    bool found = false;
    for (const auto& [rid, row] : rows) {
      if (row.values.size() >= 2 && row.values[0].type == ValueType::Text &&
          row.values[0].bytes == "HEAD") {
        Row next;
        next.values = {Value::text(Bytes("HEAD")), Value::blob(Bytes(oid))};
        db_.update_row("meta", rid, next);
        found = true;
        break;
      }
    }
    if (!found) {
      Row next;
      next.values = {Value::text(Bytes("HEAD")), Value::blob(Bytes(oid))};
      db_.insert_row("meta", next);
    }
    db_.commit();
  } catch (...) {
    db_.rollback();
    throw;
  }
}


// ---------------------------------------------------------------- tags
std::string Repo::create_tag(std::string_view name, std::string_view rev,
                             std::string_view message) {
  if (name.empty()) fail("empty tag name");
  if (!valid_ref_name("refs/tags/" + std::string(name))) {
    fail("invalid tag name: " + std::string(name));
  }
  if (ref_oid("refs/tags/" + std::string(name)).has_value()) {
    fail("tag already exists: " + std::string(name));
  }
  const std::string target = peel(resolve(rev));
  Tag tag;
  tag.object = target;
  tag.type = store_.type_of(target);
  tag.name = std::string(name);
  tag.time = now_seconds();
  tag.tz = current_tz();
  tag.message = message.empty() ? std::string(name) : std::string(message);
  if (!tag.message.empty() && tag.message.back() != '\n') tag.message += '\n';
  db_.begin();
  const std::string tag_oid = store_.write(ObjType::Tag, encode_tag(tag));
  update_ref("refs/tags/" + std::string(name), tag_oid,
             "tag: " + std::string(name));
  db_.commit();
  return tag_oid;
}

std::vector<Repo::TagInfo> Repo::list_tags() {
  std::vector<TagInfo> tags;
  const std::string prefix = "refs/tags/";
  for (const auto& [rid, row] : db_.scan_rows("refs")) {
    if (row.values.size() < 2 || row.values[0].type != ValueType::Text) continue;
    const std::string& ref_name = row.values[0].bytes;
    if (ref_name.rfind(prefix, 0) != 0) continue;
    TagInfo info;
    info.name = ref_name.substr(prefix.size());
    info.oid = row.values[1].bytes;
    if (store_.has(info.oid) && store_.type_of(info.oid) == ObjType::Tag) {
      const Tag tag = decode_tag(store_.read(info.oid));
      info.object = tag.object;
      info.message = tag.message;
    } else {
      info.object = info.oid;
    }
    tags.push_back(std::move(info));
  }
  std::sort(tags.begin(), tags.end(),
            [](const TagInfo& a, const TagInfo& b) { return a.name < b.name; });
  return tags;
}

void Repo::delete_ref(std::string_view name) {
  db_.begin();
  for (const auto& [rid, row] : db_.scan_rows("refs")) {
    if (!row.values.empty() && row.values[0].type == ValueType::Text &&
        row.values[0].bytes == std::string(name)) {
      db_.delete_row("refs", rid);
    }
  }
  db_.commit();
}

void Repo::delete_tag(std::string_view name) {
  delete_ref("refs/tags/" + std::string(name));
}

// ---------------------------------------------------------------- reset
void Repo::reset_hard(std::string_view rev) {
  const std::string target = peel(resolve(rev));
  const Commit target_commit = read_commit(target);
  checkout_tree(target_commit.tree);
  db_.begin();
  const std::string ref = head_ref();
  if (!ref.empty()) {
    update_ref(ref, target, "reset: moving to " + target.substr(0, 12));
  } else {
    meta_set("HEAD", target);
  }
  meta_remove("MERGE_HEAD");
  db_.commit();
}

// ---------------------------------------------------------------- password
void Repo::change_password(std::string_view new_password) {
  db_.change_password(new_password);
  password_ = std::string(new_password);
}
std::optional<std::string> Repo::meta_get(std::string_view key) {
  const auto rows = db_.scan_rows("meta");
  for (const auto& [rid, row] : rows) {
    if (row.values.size() >= 2 && row.values[0].type == ValueType::Text &&
        row.values[0].bytes == std::string(key)) {
      if (row.values[1].type == ValueType::Blob || row.values[1].type == ValueType::Text) {
        return row.values[1].bytes;
      }
    }
  }
  return std::nullopt;
}

void Repo::meta_set(std::string_view key, std::string_view value) {
  const auto rows = db_.scan_rows("meta");
  for (const auto& [rid, row] : rows) {
    if (row.values.size() >= 2 && row.values[0].type == ValueType::Text &&
        row.values[0].bytes == std::string(key)) {
      Row next;
      next.values = {Value::text(Bytes(key)), Value::blob(Bytes(value))};
      db_.update_row("meta", rid, next);
      return;
    }
  }
  Row row;
  row.values = {Value::text(Bytes(key)), Value::blob(Bytes(value))};
  db_.insert_row("meta", row);
}

void Repo::meta_remove(std::string_view key) {
  const auto rows = db_.scan_rows("meta");
  for (const auto& [rid, row] : rows) {
    if (row.values.size() >= 1 && row.values[0].type == ValueType::Text &&
        row.values[0].bytes == std::string(key)) {
      db_.delete_row("meta", rid);
      return;
    }
  }
}

std::map<std::string, int> Repo::ancestor_depths(const std::string& oid) {
  std::map<std::string, int> depths;
  std::vector<std::pair<std::string, int>> queue;
  queue.emplace_back(oid, 0);
  depths[oid] = 0;
  for (size_t i = 0; i < queue.size(); ++i) {
    const std::string current = queue[i].first;
    const int depth = queue[i].second;
    const Commit commit = read_commit(current);
    for (const auto& parent : commit.parents) {
      if (depths.count(parent)) continue;
      depths[parent] = depth + 1;
      queue.emplace_back(parent, depth + 1);
    }
  }
  return depths;
}

bool Repo::is_ancestor(const std::string& ancestor, const std::string& descendant) {
  if (ancestor == descendant) return true;
  return ancestor_depths(descendant).count(ancestor) > 0;
}

std::string Repo::merge_base(const std::string& a, const std::string& b) {
  const auto depths_a = ancestor_depths(a);
  const auto depths_b = ancestor_depths(b);
  std::string best;
  int best_score = 0;
  for (const auto& [oid, depth] : depths_a) {
    const auto found = depths_b.find(oid);
    if (found == depths_b.end()) continue;
    const int score = depth + found->second;
    if (best.empty() || score < best_score) {
      best = oid;
      best_score = score;
    }
  }
  return best;
}

bool Repo::merge_in_progress() { return meta_get("MERGE_HEAD").has_value(); }

void Repo::replace_index(const std::vector<IndexEntry>& entries) {
  const auto rows = db_.scan_rows("index_entries");
  for (const auto& [rid, row] : rows) db_.delete_row("index_entries", rid);
  for (const auto& entry : entries) insert_index_entry(entry);
}

Repo::MergeOutcome Repo::merge(std::string_view rev) {
  if (merge_in_progress()) fail("a merge is already in progress; commit or abort first");
  const auto head_opt = head_oid();
  if (!head_opt) fail("cannot merge: HEAD is unborn");
  const std::string head = *head_opt;
  const std::string target = resolve(rev);

  MergeOutcome outcome;
  if (target == head || is_ancestor(target, head)) return outcome;  // already up to date

  const bool fast_forward = is_ancestor(head, target);
  std::string base_oid;
  if (!fast_forward) {
    base_oid = merge_base(head, target);
    if (base_oid.empty()) fail("no common ancestor with " + std::string(rev));
  }

  std::map<std::string, IndexEntry> base_files;
  std::map<std::string, IndexEntry> ours_files;
  std::map<std::string, IndexEntry> theirs_files;
  if (!base_oid.empty()) {
    for (auto& entry : flatten_tree(read_commit(base_oid).tree)) base_files[entry.path] = entry;
  }
  for (auto& entry : flatten_tree(read_commit(head).tree)) ours_files[entry.path] = entry;
  const Commit target_commit = read_commit(target);
  for (auto& entry : flatten_tree(target_commit.tree)) theirs_files[entry.path] = entry;

  std::set<std::string> paths;
  for (const auto& [path, entry] : base_files) paths.insert(path);
  for (const auto& [path, entry] : ours_files) paths.insert(path);
  for (const auto& [path, entry] : theirs_files) paths.insert(path);

  std::vector<IndexEntry> result_entries;
  std::vector<std::string> conflicts;
  struct Triple {
    std::string base;
    std::string ours;
    std::string theirs;
  };
  std::map<std::string, Triple> conflict_objects;

  auto find_entry = [](const std::map<std::string, IndexEntry>& map,
                       const std::string& path) -> const IndexEntry* {
    const auto found = map.find(path);
    return found == map.end() ? nullptr : &found->second;
  };
  auto same_oid = [](const IndexEntry* a, const IndexEntry* b) {
    return a != nullptr && b != nullptr && a->oid == b->oid;
  };

  const auto old_index = load_index();
  // A merge must never silently replace local work: uncommitted (staged or
  // unstaged) changes make the merge ambiguous, so refuse up front. Untracked
  // files are tolerated unless the merge result would overwrite one.
  const StatusReport before = status();
  if (!before.staged_added.empty() || !before.staged_modified.empty() ||
      !before.staged_deleted.empty() || !before.modified.empty() ||
      !before.deleted.empty()) {
    fail("cannot merge: the worktree has uncommitted changes; commit or restore them first");
  }
  std::set<std::string> untracked_paths(before.untracked.begin(), before.untracked.end());
  db_.begin();
  try {
    for (const auto& path : paths) {
      const IndexEntry* pb = find_entry(base_files, path);
      const IndexEntry* po = find_entry(ours_files, path);
      const IndexEntry* pt = find_entry(theirs_files, path);

      auto record_conflict = [&](const IndexEntry* keep) {
        conflicts.push_back(path);
        Triple triple;
        if (pb) triple.base = pb->oid;
        if (po) triple.ours = po->oid;
        if (pt) triple.theirs = pt->oid;
        conflict_objects[path] = triple;
        if (keep) result_entries.push_back(*keep);
      };

      auto merge_contents = [&](const IndexEntry* pb2, const IndexEntry* po2,
                                const IndexEntry* pt2) {
        Bytes base_text;
        if (pb2) base_text = read_blob(pb2->oid);
        const Bytes ours_text = read_blob(po2->oid);
        const Bytes theirs_text = read_blob(pt2->oid);
        const bool binary = base_text.find('\0') != std::string::npos ||
                            ours_text.find('\0') != std::string::npos ||
                            theirs_text.find('\0') != std::string::npos;
        if (binary) {
          record_conflict(po2);
          return;
        }
        const MergeResult merged =
            merge3(base_text, ours_text, theirs_text, "HEAD", std::string(rev));
        IndexEntry entry = *po2;
        entry.oid = store_.write(ObjType::Blob, merged.content);
        entry.size = static_cast<int64_t>(merged.content.size());
        result_entries.push_back(entry);
        if (!merged.clean) record_conflict(nullptr);
      };

      if (fast_forward) {
        if (pt) result_entries.push_back(*pt);
        continue;
      }
      if (po && pt && po->oid == pt->oid) {
        result_entries.push_back(*po);
      } else if (same_oid(pb, po) && pt) {
        result_entries.push_back(*pt);
      } else if (same_oid(pb, pt) && po) {
        result_entries.push_back(*po);
      } else if (!po && pt && same_oid(pb, pt)) {
        continue;  // deleted by us, unchanged by them
      } else if (po && !pt && same_oid(pb, po)) {
        continue;  // deleted by them, unchanged by us
      } else if (!pb && po && !pt) {
        result_entries.push_back(*po);  // added by us only
      } else if (!pb && !po && pt) {
        result_entries.push_back(*pt);  // added by them only
      } else if (!po && pt) {
        record_conflict(pt);
      } else if (po && !pt) {
        record_conflict(po);
      } else if (po && pt && pb) {
        merge_contents(pb, po, pt);
      } else if (po && pt && !pb) {
        // add/add: identical content already handled above, otherwise conflict.
        record_conflict(po);
      } else if (po) {
        result_entries.push_back(*po);
      } else if (pt) {
        result_entries.push_back(*pt);
      }
    }

    // Materialize the merged work tree and index.
    std::set<std::string> result_paths;
    for (auto& entry : result_entries) {
      result_paths.insert(entry.path);
      if (untracked_paths.count(entry.path)) {
        fail("untracked file would be overwritten by merge: " + entry.path);
      }
      const fs::path abs = workdir_ / from_u8(entry.path);
      fs::create_directories(abs.parent_path());
      store_.write_to_file(entry.oid, abs);
      entry.size = static_cast<int64_t>(fs::file_size(abs));
      entry.mtime_ns = static_cast<int64_t>(
          std::chrono::duration_cast<std::chrono::nanoseconds>(
              fs::last_write_time(abs).time_since_epoch())
              .count());
      insert_index_entry(entry);
    }
    std::set<std::string> staged_only;
    for (const auto& entry : old_index) {
      if (ours_files.find(entry.path) == ours_files.end()) staged_only.insert(entry.path);
    }
    for (const auto& entry : old_index) {
      if (result_paths.count(entry.path)) continue;
      // Staged-but-never-committed files are not part of HEAD; a merge must not
      // delete them (the dirty-state guard normally rejects this case already).
      if (staged_only.count(entry.path)) continue;
      std::error_code ec;
      fs::remove(workdir_ / from_u8(entry.path), ec);
      remove_index_path(entry.path);
    }

    if (!conflicts.empty()) {
      for (const auto& path : conflicts) {
        const Triple& triple = conflict_objects[path];
        Row row;
        row.values = {Value::text(Bytes(path)), Value::text(Bytes(triple.base)),
                      Value::text(Bytes(triple.ours)), Value::text(Bytes(triple.theirs))};
        db_.insert_row("merge_state", row);
      }
      meta_set("MERGE_HEAD", target);
      db_.commit();
      outcome.kind = MergeOutcome::Kind::Conflicted;
      outcome.conflicts = conflicts;
      return outcome;
    }

    if (fast_forward) {
      const std::string ref = head_ref();
      if (ref.empty()) {
        meta_set("HEAD", target);
      } else {
        update_ref(ref, target, "merge: fast-forward");
      }
      db_.commit();
      outcome.kind = MergeOutcome::Kind::FastForward;
      outcome.commit_oid = target;
      return outcome;
    }

    for (const auto& [rid, row] : db_.scan_rows("merge_state")) db_.delete_row("merge_state", rid);
    Commit merge_commit;
    merge_commit.tree = tree_from_index(result_entries);
    merge_commit.parents = {head, target};
    merge_commit.time = now_seconds();
    merge_commit.tz = current_tz();
    merge_commit.message = "Merge " + std::string(rev) + "\n";
    const std::string oid = write_commit(merge_commit);
    const std::string ref = head_ref();
    if (ref.empty()) {
      meta_set("HEAD", oid);
    } else {
      update_ref(ref, oid, "merge");
    }
    meta_remove("MERGE_HEAD");
    db_.commit();
    outcome.kind = MergeOutcome::Kind::Merged;
    outcome.commit_oid = oid;
    return outcome;
  } catch (...) {
    db_.rollback();
    throw;
  }
}

void Repo::rm_paths(const std::vector<std::string>& paths, bool cached) {
  if (paths.empty()) fail("rm needs at least one path");
  const std::vector<IndexEntry> index = load_index();
  auto is_tracked = [&index](const std::string& path) {
    for (const auto& entry : index) {
      if (entry.path == path) return true;
    }
    return false;
  };
  db_.begin();
  try {
    for (const auto& raw : paths) {
      const std::string rel = repo_relative_inside(workdir_, raw);
      if (path_is_repo_internal(rel)) fail("refusing to touch repository internals");
      if (!is_tracked(rel)) {
        fail("path is not tracked: " + rel + " (untracked files are not removed by rm)");
      }
      remove_index_path(rel);
      if (!cached) {
        std::error_code ec;
        if (fs::exists(workdir_ / from_u8(rel), ec) && !ec) {
          fs::remove(workdir_ / from_u8(rel), ec);
          if (ec) fail("cannot remove " + rel + ": " + ec.message());
        }
      }
    }
    db_.commit();
  } catch (...) {
    db_.rollback();
    throw;
  }
}

void Repo::mv_path(std::string_view from, std::string_view to) {
  const std::string src = repo_relative_inside(workdir_, from);
  const std::string dst = repo_relative_inside(workdir_, to);
  if (src.empty() || dst.empty()) fail("mv needs two paths");
  db_.begin();
  try {
    const fs::path src_abs = workdir_ / from_u8(src);
    const fs::path dst_abs = workdir_ / from_u8(dst);
    if (!fs::exists(src_abs)) fail("path does not exist: " + src);
    fs::create_directories(dst_abs.parent_path());
    std::error_code ec;
    fs::rename(src_abs, dst_abs, ec);
    if (ec) fail("cannot rename " + src + ": " + ec.message());

    std::optional<IndexEntry> moved;
    for (const auto& entry : load_index()) {
      if (entry.path == src) moved = entry;
    }
    remove_index_path(src);
    if (moved) {
      IndexEntry entry = *moved;
      entry.path = dst;
      insert_index_entry(entry);
    }
    db_.commit();
  } catch (...) {
    db_.rollback();
    throw;
  }
}

std::size_t Repo::restore_paths(const std::vector<std::string>& paths) {
  const auto head = head_oid();
  if (!head) fail("HEAD is unborn; nothing to restore");
  const Commit commit = read_commit(peel(*head));
  std::set<std::string> wanted;
  for (const auto& raw : paths) {
    wanted.insert(repo_relative_inside(workdir_, raw));
  }
  std::size_t restored = 0;
  db_.begin();
  try {
    for (const auto& entry : flatten_tree(commit.tree)) {
      if (!wanted.empty() && !wanted.count(entry.path)) continue;
      const fs::path file = workdir_ / from_u8(entry.path);
      if (!file.parent_path().empty()) fs::create_directories(file.parent_path());
      store_.write_to_file(entry.oid, file);
      IndexEntry index_entry;
      index_entry.path = entry.path;
      index_entry.mode = entry.mode;
      index_entry.oid = entry.oid;
      index_entry.size = static_cast<int64_t>(fs::file_size(file));
      index_entry.mtime_ns = 0;
      remove_index_path(entry.path);
      insert_index_entry(index_entry);
      ++restored;
    }
    db_.commit();
  } catch (...) {
    db_.rollback();
    throw;
  }
  return restored;
}

std::vector<std::string> Repo::clean_untracked(bool dry_run) {
  const StatusReport report = status();
  std::vector<std::string> removed;
  std::error_code root_ec;
  const fs::path canonical_root = fs::weakly_canonical(workdir_, root_ec);
  for (const auto& path : report.untracked) {
    const fs::path abs = workdir_ / from_u8(path);
    std::error_code ec;
    // Never remove links or reparse points (their targets may live outside).
    if (is_reparse_point(abs)) continue;
    const fs::file_status st = fs::symlink_status(abs, ec);
    if (ec || !fs::is_regular_file(st)) continue;
    if (!root_ec) {
      const fs::path canonical_parent = fs::weakly_canonical(abs.parent_path(), ec);
      if (ec) continue;
      const std::string rel = u8(canonical_parent.lexically_relative(canonical_root));
      if (rel == ".." || rel.rfind("../", 0) == 0) continue;
    }
    removed.push_back(path);
    if (dry_run) continue;
    fs::remove(abs, ec);
  }
  return removed;
}

void Repo::add_placeholder(std::string_view path, std::string_view reason) {
  const fs::path raw_path = from_u8(path);
  const fs::path abs = raw_path.is_absolute() ? raw_path : workdir_ / raw_path;
  std::string rel = u8(fs::relative(abs, workdir_));
  std::replace(rel.begin(), rel.end(), '\\', '/');
  if (rel.empty() || rel.rfind("..", 0) == 0) {
    fail("placeholder path must stay inside the repository: " + std::string(path));
  }
  if (fs::exists(workdir_ / from_u8(rel))) {
    fail("file already exists, nothing to place: " + rel);
  }
  for (const auto& [rid, row] : db_.scan_rows("placeholders")) {
    if (row.values.size() >= 1 && row.values[0].type == ValueType::Text &&
        row.values[0].bytes == rel) {
      Row next;
      next.values = {Value::text(Bytes(rel)), Value::text(Bytes(reason)),
                     row.values.size() >= 3 ? row.values[2] : Value::integer(now_seconds())};
      db_.update_row("placeholders", rid, next);
      return;
    }
  }
  Row row;
  row.values = {Value::text(Bytes(rel)), Value::text(Bytes(reason)),
                Value::integer(now_seconds())};
  db_.insert_row("placeholders", row);
}

bool Repo::remove_placeholder(std::string_view path) {
  for (const auto& [rid, row] : db_.scan_rows("placeholders")) {
    if (row.values.size() >= 1 && row.values[0].type == ValueType::Text &&
        row.values[0].bytes == std::string(path)) {
      db_.delete_row("placeholders", rid);
      return true;
    }
  }
  return false;
}

std::vector<PlaceholderInfo> Repo::list_placeholders() {
  std::vector<PlaceholderInfo> result;
  for (const auto& [rid, row] : db_.scan_rows("placeholders")) {
    (void)rid;
    if (row.values.size() < 1 || row.values[0].type != ValueType::Text) continue;
    PlaceholderInfo info;
    info.path = row.values[0].bytes;
    if (row.values.size() >= 2) info.reason = row.values[1].bytes;
    if (row.values.size() >= 3) info.created_ts = row.values[2].int_value;
    result.push_back(std::move(info));
  }
  std::sort(result.begin(), result.end(),
            [](const PlaceholderInfo& a, const PlaceholderInfo& b) {
              return a.path < b.path;
            });
  return result;
}

std::vector<std::pair<std::string, std::string>> Repo::list_refs() {
  std::vector<std::pair<std::string, std::string>> refs;
  for (const auto& [rid, row] : db_.scan_rows("refs")) {
    if (row.values.size() >= 2 && row.values[0].type == ValueType::Text &&
        row.values[1].type == ValueType::Text) {
      refs.emplace_back(row.values[0].bytes, row.values[1].bytes);
    }
  }
  return refs;
}

Repo::GcStats Repo::gc() { return gc(GcOptions{}); }

namespace {

// Existing delta chain depth above an object (0 when it is not a delta). A
// broken or cyclic base chain reports kBrokenDeltaDepth so it is never chosen
// as the base of a new delta.
constexpr int kBrokenDeltaDepth = 1 << 20;

}  // namespace

Repo::GcStats Repo::gc(const GcOptions& options) {
  ensure_schema();
  const bool full = options.full_repack();
  GcStats stats;
  stats.incremental = !full;
  db_.begin();
  try {
    const int64_t started_ts = now_seconds();

    // Incremental mode only considers objects written since the previous pass
    // started; the bookmark lives in meta as `gc.last_ts`. The comparison is
    // inclusive, so objects written in the same second as the bookmark are
    // revisited (harmless: already-delta objects are skipped for encoding).
    int64_t previous_ts = -1;
    if (!full) {
      if (const auto raw = meta_get("gc.last_ts")) {
        try {
          previous_ts = std::stoll(*raw);
        } catch (const std::exception&) {
          previous_ts = -1;
        }
      }
    }
    auto is_candidate = [&](const ObjectStore::StoredObject& object) {
      if (full || previous_ts < 0) return true;
      return object.created_ts >= previous_ts;
    };

    // 0. Snapshot the object metadata once; nothing is inserted or dropped
    // before step 4 (delta encoding only rewrites existing rows).
    const std::vector<ObjectStore::StoredObject> snapshot = store_.list_objects();
    std::map<std::string, const ObjectStore::StoredObject*> by_oid;
    int64_t before_bytes = 0;
    size_t initial_deltas = 0;
    size_t candidates = 0;
    for (const auto& object : snapshot) {
      by_oid[object.oid] = &object;
      before_bytes += object.stored_bytes;
      if (object.storage == 2) ++initial_deltas;
      if (is_candidate(object)) ++candidates;
    }
    stats.bytes_before = before_bytes;
    stats.candidate_objects = candidates;

    // 1. Reachability closure from refs and HEAD. Blob leaves need no payload
    // read; only commit/tree/tag rows have to be decoded.
    std::set<std::string> reachable;
    std::vector<std::string> stack;
    for (const auto& [name, oid] : list_refs()) stack.push_back(oid);
    if (auto head = head_oid()) stack.push_back(*head);
    // Staged blobs are reachable: dropping them would leave the index pointing
    // at missing objects (fsck problems and a broken restore after gc).
    for (const auto& entry : load_index()) stack.push_back(entry.oid);
    // Commit graph, used to order per-path versions by ancestry below.
    std::map<std::string, std::vector<std::string>> commit_parents;
    std::map<std::string, int64_t> commit_time;
    while (!stack.empty()) {
      const std::string oid = stack.back();
      stack.pop_back();
      if (oid.empty() || !reachable.insert(oid).second) continue;
      const auto found = by_oid.find(oid);
      if (found == by_oid.end()) continue;                 // dangling link; fsck reports it
      if (found->second->type == ObjType::Blob) continue;  // leaf, has no links
      std::string payload;
      try {
        payload = store_.read(oid);
        if (found->second->type == ObjType::Commit) {
          const Commit commit = decode_commit(payload);
          commit_parents[oid] = commit.parents;
          commit_time[oid] = commit.time;
          for (const auto& parent : commit.parents) stack.push_back(parent);
          stack.push_back(commit.tree);
        } else if (found->second->type == ObjType::Tree) {
          for (const auto& entry : decode_tree(payload)) stack.push_back(entry.oid);
        } else if (found->second->type == ObjType::Tag) {
          stack.push_back(decode_tag(payload).object);
        }
      } catch (const std::exception&) {
        continue;  // a broken object is kept in place; fsck reports it
      }
    }
    stats.objects_scanned = reachable.size();

    // 2. Collect per-path blob chains in ancestry order. Commit timestamps are
    // only a tie-break: several commits can share one second, so the order must
    // come from the DAG (parents before children) or the newest version could
    // be placed before its base and never get delta-encoded.
    std::map<std::string, std::vector<std::string>> children;
    std::map<std::string, int> waiting_parents;
    std::set<std::pair<int64_t, std::string>> ready;
    for (const auto& [oid, parents] : commit_parents) {
      int need = 0;
      for (const auto& parent : parents) {
        if (commit_parents.count(parent) == 0) continue;  // parent not reachable
        children[parent].push_back(oid);
        ++need;
      }
      waiting_parents[oid] = need;
      if (need == 0) ready.emplace(commit_time[oid], oid);
    }
    std::vector<std::string> commit_order;
    commit_order.reserve(commit_parents.size());
    while (!ready.empty()) {
      const auto next = ready.begin();
      const std::string oid = next->second;
      ready.erase(next);
      commit_order.push_back(oid);
      for (const auto& child : children[oid]) {
        if (--waiting_parents[child] == 0) ready.emplace(commit_time[child], child);
      }
    }
    std::map<std::string, std::vector<std::string>> chains;
    for (const auto& oid : commit_order) {
      std::vector<IndexEntry> entries;
      try {
        entries = flatten_tree(decode_commit(store_.read(oid)).tree);
      } catch (const std::exception&) {
        continue;
      }
      for (const auto& entry : entries) {
        auto& chain = chains[entry.path];
        if (chain.empty() || chain.back() != entry.oid) chain.push_back(entry.oid);
      }
    }

    // 3. Encode deltas against recent earlier versions. Chunked (large) blobs
    // keep their content-addressed chunk dedupe; delta bases must stay small
    // enough to decode in memory. Incremental mode skips every object that is
    // already a delta, so existing payload/base_oid rows stay byte-identical.
    const int64_t inline_cap = static_cast<int64_t>(store_.inline_limit());

    // Delta depth of existing rows (memoized) so max_chain also counts bases
    // that this pass leaves untouched.
    std::map<std::string, int> depth_memo;
    auto depth_of = [&](const std::string& oid) -> int {
      if (const auto memo = depth_memo.find(oid); memo != depth_memo.end()) {
        return memo->second;
      }
      std::vector<std::string> path;
      std::set<std::string> seen;
      std::string current = oid;
      int base_depth = 0;
      bool broken = false;
      while (true) {
        if (const auto memo = depth_memo.find(current); memo != depth_memo.end()) {
          base_depth += memo->second;
          break;
        }
        const auto found = by_oid.find(current);
        if (found == by_oid.end()) {
          broken = true;
          break;
        }
        const ObjectStore::StoredObject& object = *found->second;
        if (object.storage != 2) break;  // plain object ends the chain
        if (object.base_oid.empty() || !seen.insert(current).second) {
          broken = true;
          break;
        }
        path.push_back(current);
        current = object.base_oid;
      }
      if (broken) {
        for (const auto& node : path) depth_memo[node] = kBrokenDeltaDepth;
        return kBrokenDeltaDepth;
      }
      int depth = base_depth;
      for (size_t i = path.size(); i-- > 0;) {
        ++depth;
        depth_memo[path[i]] = depth;
      }
      return depth;
    };
    // Depth an object will have after this pass (rewritten rows override).
    std::map<std::string, int> rewritten_depth;
    auto depth_for_base = [&](const std::string& oid) -> int {
      if (const auto found = rewritten_depth.find(oid); found != rewritten_depth.end()) {
        return found->second;
      }
      return depth_of(oid);
    };

    std::set<std::string> rewritten_from_delta;  // were storage=2 before this pass
    int64_t projected_savings = 0;               // dry-run projection
    for (const auto& [path, chain] : chains) {
      (void)path;
      for (size_t i = 1; i < chain.size(); ++i) {
        const auto found = by_oid.find(chain[i]);
        if (found == by_oid.end()) continue;
        const ObjectStore::StoredObject& target = *found->second;
        if (!full) {
          if (target.storage == 2) continue;    // never re-encode existing deltas
          if (!is_candidate(target)) continue;  // only objects from this cycle
        }
        if (target.raw_size > inline_cap || target.stored_bytes <= 0) continue;
        std::string target_payload;
        try {
          target_payload = store_.read(target.oid);
        } catch (const std::exception&) {
          continue;
        }
        const size_t first = i > options.window ? i - options.window : 0;
        size_t best_base = chain.size();
        int64_t best_size = target.stored_bytes;
        Bytes best_delta;
        for (size_t j = first; j < i; ++j) {
          const auto base = by_oid.find(chain[j]);
          if (base == by_oid.end()) continue;
          if (base->second->raw_size > inline_cap) continue;
          if (depth_for_base(chain[j]) + 1 > static_cast<int>(options.max_chain)) continue;
          std::string base_payload;
          try {
            base_payload = store_.read(chain[j]);
          } catch (const std::exception&) {
            continue;
          }
          Bytes delta = delta::make_delta(bytes_span(base_payload), bytes_span(target_payload));
          if (static_cast<int64_t>(delta.size()) < best_size) {
            best_size = static_cast<int64_t>(delta.size());
            best_base = j;
            best_delta = std::move(delta);
          }
        }
        if (best_base == chain.size()) continue;
        const double saving =
            1.0 - static_cast<double>(best_size) / static_cast<double>(target.stored_bytes);
        if (saving < options.min_saving) continue;
        const std::string& base_oid = chain[best_base];
        rewritten_depth[target.oid] = depth_for_base(base_oid) + 1;
        if (target.storage == 2) rewritten_from_delta.insert(target.oid);
        ++stats.deltas_written;
        if (options.dry_run) {
          projected_savings += target.stored_bytes - best_size;
        } else {
          store_.store_delta(target.oid, base_oid, best_delta, target.raw_size);
        }
      }
    }

    // 4. Drop unreachable objects. Incremental mode is conservative: it only
    // removes objects from the current candidate set. In both modes a delta
    // base (which is not part of the commit graph) is kept as long as some
    // surviving object still references it.
    std::set<std::string> unreachable;
    for (const auto& object : snapshot) {
      if (reachable.count(object.oid)) continue;
      if (!is_candidate(object)) continue;
      unreachable.insert(object.oid);
    }
    std::set<std::string> survivors;
    for (const auto& object : snapshot) {
      if (!unreachable.count(object.oid)) survivors.insert(object.oid);
    }
    std::vector<std::string> work(survivors.begin(), survivors.end());
    while (!work.empty()) {
      const std::string oid = work.back();
      work.pop_back();
      const auto found = by_oid.find(oid);
      if (found == by_oid.end()) continue;
      const std::string& base = found->second->base_oid;
      if (base.empty()) continue;
      if (survivors.insert(base).second) work.push_back(base);
    }
    std::vector<std::string> to_remove;
    int64_t removed_bytes = 0;
    size_t removed_deltas = 0;
    for (const auto& object : snapshot) {
      if (!unreachable.count(object.oid)) continue;
      if (survivors.count(object.oid)) continue;  // still needed as a delta base
      to_remove.push_back(object.oid);
      removed_bytes += object.stored_bytes;
      if (object.storage == 2) ++removed_deltas;
    }
    if (options.dry_run) {
      stats.objects_removed = to_remove.size();
    } else {
      for (const auto& oid : to_remove) {
        store_.remove(oid);
        ++stats.objects_removed;
      }
    }
    const size_t reclaimed_deltas = rewritten_from_delta.size() + removed_deltas;
    stats.deltas_kept =
        reclaimed_deltas <= initial_deltas ? initial_deltas - reclaimed_deltas : 0;

    // 5. Report sizing, then move the incremental bookmark. A dry run must not
    // move it, otherwise the objects it only estimated would be skipped by the
    // next real pass.
    if (options.dry_run) {
      stats.bytes_after = before_bytes - projected_savings - removed_bytes;
    } else {
      int64_t after_bytes = 0;
      for (const auto& object : store_.list_objects()) after_bytes += object.stored_bytes;
      stats.bytes_after = after_bytes;
      int64_t generation = 0;
      if (const auto raw = meta_get("gc.generation")) {
        try {
          generation = std::stoll(*raw);
        } catch (const std::exception&) {
          generation = 0;
        }
      }
      meta_set("gc.last_ts", std::to_string(started_ts));
      meta_set("gc.generation", std::to_string(generation + 1));
    }

    db_.commit();
    return stats;
  } catch (...) {
    db_.rollback();
    throw;
  }
}

Repo::FsckReport Repo::fsck() {
  ensure_schema();
  FsckReport report;
  for (const auto& object : store_.list_objects()) {
    ++report.objects;
    ObjType type = ObjType::Blob;
    std::string payload;
    try {
      payload = store_.read(object.oid, &type);
    } catch (const std::exception& e) {
      report.errors.push_back("object " + object.oid + ": " + e.what());
      continue;
    }
    if (type != object.type) {
      report.errors.push_back("object " + object.oid + ": type mismatch");
    }
    switch (type) {
      case ObjType::Commit: ++report.commits; break;
      case ObjType::Tree: ++report.trees; break;
      case ObjType::Blob: ++report.blobs; break;
      case ObjType::Tag: ++report.tags; break;
    }
    if (type == ObjType::Commit) {
      try {
        const Commit commit = decode_commit(payload);
        for (const auto& parent : commit.parents) {
          if (!store_.has(parent)) report.errors.push_back("commit " + object.oid + ": missing parent " + parent);
        }
        if (!store_.has(commit.tree)) report.errors.push_back("commit " + object.oid + ": missing tree " + commit.tree);
      } catch (const std::exception& e) {
        report.errors.push_back("commit " + object.oid + ": " + e.what());
      }
    } else if (type == ObjType::Tree) {
      try {
        for (const auto& entry : decode_tree(payload)) {
          if (!store_.has(entry.oid)) {
            report.errors.push_back("tree " + object.oid + ": missing entry " + entry.name);
            continue;
          }
          const ObjType entry_type = store_.type_of(entry.oid);
          const bool wants_tree = (entry.mode & 0170000) == 0040000;
          if (wants_tree != (entry_type == ObjType::Tree)) {
            report.errors.push_back("tree " + object.oid + ": entry " + entry.name + " has wrong type");
          }
        }
      } catch (const std::exception& e) {
        report.errors.push_back("tree " + object.oid + ": " + e.what());
      }
    } else if (type == ObjType::Tag) {
      try {
        const Tag tag = decode_tag(payload);
        if (!store_.has(tag.object)) report.errors.push_back("tag " + object.oid + ": missing target " + tag.object);
      } catch (const std::exception& e) {
        report.errors.push_back("tag " + object.oid + ": " + e.what());
      }
    }
  }

  for (const auto& [name, oid] : list_refs()) {
    if (!store_.has(oid)) report.errors.push_back("ref " + name + ": missing object " + oid);
  }
  try {
    if (auto head = head_oid()) {
      if (!store_.has(*head)) report.errors.push_back("HEAD: missing object " + *head);
    }
  } catch (const std::exception& e) {
    report.errors.push_back(std::string("HEAD: ") + e.what());
  }
  try {
    for (const auto& entry : load_index()) {
      if (!store_.has(entry.oid)) report.errors.push_back("index " + entry.path + ": missing object " + entry.oid);
    }
  } catch (const std::exception& e) {
    report.errors.push_back(std::string("index: ") + e.what());
  }
  return report;
}

}  // namespace iaqs::vcs
