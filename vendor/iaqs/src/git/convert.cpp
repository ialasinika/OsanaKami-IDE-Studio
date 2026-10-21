#include "git/convert.h"

#include <algorithm>
#include <array>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "core/util.h"
#include "git/pack.h"
#include "git/sha1.h"
#include "git/zlib_stream.h"
#include "vcs/objects.h"

namespace iaqs::git {
namespace {

namespace fs = std::filesystem;
using iaqs::vcs::Commit;
using iaqs::vcs::ObjType;
using iaqs::vcs::Repo;
using iaqs::vcs::Tag;
using iaqs::vcs::TreeEntry;

[[noreturn]] void fail(const std::string& what) { throw std::runtime_error("git: " + what); }

using GitId = std::array<uint8_t, 20>;
using GitIdKey = std::string;  // raw 20 bytes

GitId parse_hex_id(std::string_view text) {
  GitId id{};
  if (text.size() < 40) fail("short object id");
  Bytes raw;
  if (!from_hex(text.substr(0, 40), raw) || raw.size() != 20) fail("bad object id");
  std::memcpy(id.data(), raw.data(), 20);
  return id;
}

std::string hex_id(const GitId& id) {
  return to_hex(ByteSpan(id.data(), id.size()));
}

GitIdKey key_of(const GitId& id) {
  return GitIdKey(reinterpret_cast<const char*>(id.data()), id.size());
}

std::string read_text_file(const fs::path& path) {
  return read_file(path.string());
}

std::string trim_copy(std::string_view text) {
  std::size_t begin = 0;
  std::size_t end = text.size();
  while (begin < end && (text[begin] == ' ' || text[begin] == '\t' || text[begin] == '\r' ||
                         text[begin] == '\n')) {
    ++begin;
  }
  while (end > begin && (text[end - 1] == ' ' || text[end - 1] == '\t' ||
                         text[end - 1] == '\r' || text[end - 1] == '\n')) {
    --end;
  }
  return std::string(text.substr(begin, end - begin));
}

struct GitObject {
  uint8_t type = 0;  // 1 commit, 2 tree, 3 blob, 4 tag
  Bytes payload;
};

struct RawHeader {
  std::string type;
  uint64_t size = 0;
  Bytes payload;
};

RawHeader parse_object_header(ByteSpan data) {
  const std::string_view text = bytes_view(data);
  const std::size_t space = text.find(' ');
  if (space == std::string_view::npos) fail("bad object header");
  const std::size_t nul = text.find('\0', space + 1);
  if (nul == std::string_view::npos) fail("bad object header");
  RawHeader header;
  header.type = std::string(text.substr(0, space));
  header.size = static_cast<uint64_t>(std::stoull(std::string(text.substr(space + 1, nul - space - 1))));
  header.payload = Bytes(reinterpret_cast<const char*>(data.data() + nul + 1),
                         data.size() - nul - 1);
  if (header.payload.size() != header.size) fail("object size mismatch");
  return header;
}

uint8_t git_type_of_name(std::string_view name) {
  if (name == "commit") return 1;
  if (name == "tree") return 2;
  if (name == "blob") return 3;
  if (name == "tag") return 4;
  fail("unsupported object type '" + std::string(name) + "'");
}

// ------------------------------------------------------------------ export

struct ExportObject {
  std::string oid;  // iaqs hex64
  ObjType type = ObjType::Blob;
  uint8_t pack_type = 0;  // git pack type (1 commit, 2 tree, 3 blob, 4 tag)
  Bytes payload;
  GitId git_id{};
};

// iaqs enumerates Blob=1/Tree=2/Commit=3/Tag=4, while git packs use
// Commit=1/Tree=2/Blob=3/Tag=4; the ids must be computed with git's numbering.
uint8_t git_pack_type(ObjType type) {
  switch (type) {
    case ObjType::Commit: return 1;
    case ObjType::Tree: return 2;
    case ObjType::Blob: return 3;
    case ObjType::Tag: return 4;
  }
  fail("unsupported object type");
}

std::string identity_field(const GitIdentity& identity, int64_t time, std::string_view tz) {
  return identity.name + " <" + identity.email + "> " + std::to_string(time) + " " +
         std::string(tz);
}

std::string git_mode_text(uint32_t mode, ObjType type) {
  if (type == ObjType::Tree) return "40000";
  switch (mode) {
    case vcs::kModeExec: return "100755";
    case vcs::kModeSymlink: return "120000";
    default: return "100644";
  }
}

bool safe_ref_name(std::string_view ref) {
  if (ref.empty() || ref.front() == '/' || ref.back() == '/' ||
      ref.find('\\') != std::string_view::npos ||
      ref.find("..") != std::string_view::npos) {
    return false;
  }
  std::size_t start = 0;
  while (true) {
    const std::size_t slash = ref.find('/', start);
    const std::string_view part =
        ref.substr(start, slash == std::string_view::npos ? std::string_view::npos
                                                          : slash - start);
    if (part.empty() || part == ".") return false;
    for (const unsigned char byte : part) {
      if (byte < 0x20 || byte == 0x7f) return false;
    }
    if (slash == std::string_view::npos) break;
    start = slash + 1;
  }
  return true;
}

void write_ref_file(const fs::path& out_dir, std::string_view ref, std::string_view hex) {
  if (!safe_ref_name(ref)) fail("export: unsafe ref name: " + std::string(ref));
  std::error_code ec;
  const fs::path root = fs::weakly_canonical(out_dir, ec);
  const fs::path path = out_dir / fs::path(std::string(ref));
  fs::path parent = fs::weakly_canonical(path.parent_path(), ec);
  if (ec) fail("export: cannot resolve ref path for " + std::string(ref));
  const fs::path rel = parent.lexically_relative(root);
  if (rel.empty() || rel.is_absolute() || rel.generic_string().rfind("..", 0) == 0) {
    fail("export: ref escapes the output directory: " + std::string(ref));
  }
  fs::create_directories(path.parent_path());
  const std::string content = std::string(hex) + "\n";
  write_file(path.string(), bytes_span(content));
}

PackExportStats export_packs(Repo& repo, const PackExportOptions& options) {
  if (options.out_dir.empty()) fail("export: --out directory is required");
  fs::create_directories(options.out_dir);

  std::vector<std::pair<std::string, std::string>> refs = repo.list_refs();
  std::vector<std::string> tips;
  for (const auto& [name, oid] : refs) tips.push_back(oid);
  if (const std::optional<std::string> head = repo.head_oid()) tips.push_back(*head);

  std::unordered_set<std::string> visited;
  std::vector<std::string> order;  // children before parents
  std::vector<std::pair<std::string, int>> stack;
  for (const std::string& tip : tips) stack.emplace_back(tip, 0);
  while (!stack.empty()) {
    auto [oid, phase] = stack.back();
    stack.pop_back();
    if (phase == 1) {
      order.push_back(oid);
      continue;
    }
    if (!visited.insert(oid).second) continue;
    stack.emplace_back(oid, 1);
    const ObjType type = repo.objects().type_of(oid);
    if (type == ObjType::Commit) {
      const Commit commit = repo.read_commit(oid);
      if (!commit.tree.empty()) stack.emplace_back(commit.tree, 0);
      for (const std::string& parent : commit.parents) stack.emplace_back(parent, 0);
    } else if (type == ObjType::Tree) {
      const std::vector<TreeEntry> entries = repo.read_tree(oid);
      for (const TreeEntry& entry : entries) stack.emplace_back(entry.oid, 0);
    } else if (type == ObjType::Tag) {
      const std::string payload = repo.objects().read(oid);
      const Tag tag = vcs::decode_tag(payload);
      stack.emplace_back(tag.object, 0);
    }
  }

  std::unordered_map<std::string, GitId> git_ids;
  std::vector<ExportObject> converted;
  converted.reserve(order.size());
  for (const std::string& oid : order) {
    ExportObject object;
    object.oid = oid;
    object.payload = repo.objects().read(oid, &object.type);
    switch (object.type) {
      case ObjType::Blob:
        break;
      case ObjType::Tree: {
        std::vector<TreeEntry> entries = repo.read_tree(oid);
        std::stable_sort(entries.begin(), entries.end(), [](const TreeEntry& a, const TreeEntry& b) {
          std::string ka = a.name + (a.type == ObjType::Tree ? "/" : "");
          std::string kb = b.name + (b.type == ObjType::Tree ? "/" : "");
          return ka < kb;
        });
        Bytes payload;
        for (const TreeEntry& entry : entries) {
          const auto found = git_ids.find(entry.oid);
          if (found == git_ids.end()) fail("tree child was not converted first");
          payload.append(git_mode_text(entry.mode, entry.type));
          payload.push_back(' ');
          payload.append(entry.name);
          payload.push_back('\0');
          payload.append(reinterpret_cast<const char*>(found->second.data()), 20);
        }
        object.payload = std::move(payload);
        break;
      }
      case ObjType::Commit: {
        const Commit commit = repo.read_commit(oid);
        const auto tree = git_ids.find(commit.tree);
        if (tree == git_ids.end()) fail("commit tree was not converted first");
        Bytes payload;
        payload.append("tree ");
        payload.append(hex_id(tree->second));
        payload.push_back('\n');
        for (const std::string& parent : commit.parents) {
          const auto found = git_ids.find(parent);
          if (found == git_ids.end()) fail("commit parent was not converted first");
          payload.append("parent ");
          payload.append(hex_id(found->second));
          payload.push_back('\n');
        }
        const std::string identity =
            identity_field(options.identity, commit.time, commit.tz);
        payload.append("author " + identity + "\n");
        payload.append("committer " + identity + "\n\n");
        payload.append(commit.message);
        if (payload.empty() || payload.back() != '\n') payload.push_back('\n');
        object.payload = std::move(payload);
        break;
      }
      case ObjType::Tag: {
        const Tag tag = vcs::decode_tag(object.payload);
        const auto target = git_ids.find(tag.object);
        if (target == git_ids.end()) fail("tag target was not converted first");
        Bytes payload;
        payload.append("object " + hex_id(target->second) + "\n");
        payload.append("type " + std::string(vcs::type_name(tag.type)) + "\n");
        payload.append("tag " + tag.name + "\n");
        payload.append("tagger " + identity_field(options.identity, tag.time, tag.tz) + "\n\n");
        payload.append(tag.message);
        if (payload.empty() || payload.back() != '\n') payload.push_back('\n');
        object.payload = std::move(payload);
        break;
      }
    }
    object.pack_type = git_pack_type(object.type);
    object.git_id = git_object_id(pack_type_name(object.pack_type),
                                  bytes_span(object.payload));
    git_ids.emplace(oid, object.git_id);
    converted.push_back(std::move(object));
  }

  PackExportStats stats;
  stats.objects = converted.size();
  const std::size_t per_pack = std::max<std::size_t>(1, options.max_objects_per_pack);
  for (std::size_t begin = 0; begin < converted.size(); begin += per_pack) {
    const std::size_t end = std::min(converted.size(), begin + per_pack);
    std::vector<PackObject> objects;
    objects.reserve(end - begin);
    for (std::size_t i = begin; i < end; ++i) {
      PackObject object;
      object.type = converted[i].pack_type;
      object.id = converted[i].git_id;
      object.payload = converted[i].payload;
      objects.push_back(std::move(object));
    }
    const fs::path tmp_prefix = options.out_dir / ("tmp-" + std::to_string(begin));
    const std::string checksum = write_pack(tmp_prefix, objects);
    const fs::path final_pack = options.out_dir / ("pack-" + checksum + ".pack");
    const fs::path final_idx = options.out_dir / ("pack-" + checksum + ".idx");
    fs::rename(tmp_prefix.string() + ".pack", final_pack);
    fs::rename(tmp_prefix.string() + ".idx", final_idx);
    ++stats.packs;
  }

  for (const auto& [name, oid] : refs) {
    const auto found = git_ids.find(oid);
    if (found == git_ids.end()) continue;
    write_ref_file(options.out_dir, name, hex_id(found->second));
    ++stats.refs;
  }
  if (const std::optional<std::string> head = repo.head_oid()) {
    const std::string head_ref = repo.head_ref();
    if (!head_ref.empty()) {
      const std::string content = "ref: " + head_ref + "\n";
      write_file((options.out_dir / "HEAD").string(), bytes_span(content));
    } else {
      const auto found = git_ids.find(*head);
      if (found != git_ids.end()) {
        write_file((options.out_dir / "HEAD").string(),
                   bytes_span(hex_id(found->second) + "\n"));
      }
    }
  }
  return stats;
}

// ------------------------------------------------------------------ import

class GitObjectSource {
 public:
  explicit GitObjectSource(fs::path objects_dir) : objects_dir_(std::move(objects_dir)) {
    const fs::path pack_dir = objects_dir_ / "pack";
    if (!fs::exists(pack_dir)) return;
    std::vector<fs::path> packs;
    for (const auto& entry : fs::directory_iterator(pack_dir)) {
      if (entry.path().extension() == ".pack") packs.push_back(entry.path());
    }
    std::sort(packs.begin(), packs.end());
    for (const fs::path& path : packs) {
      const fs::path idx = path.parent_path() / (path.stem().string() + ".idx");
      const PackFile pack = read_pack(path, fs::exists(idx) ? idx : fs::path{});
      for (const PackObject& object : pack.objects) {
        GitObject data;
        data.type = object.type;
        data.payload = object.payload;
        objects_.emplace(key_of(object.id), std::move(data));
      }
    }
  }

  const GitObject& get(const GitIdKey& key) {
    const auto cached = objects_.find(key);
    if (cached != objects_.end()) return cached->second;
    if (key.size() != 20) fail("bad object key");
    const std::string hex = to_hex(ByteSpan(reinterpret_cast<const uint8_t*>(key.data()), 20));
    const fs::path loose = objects_dir_ / hex.substr(0, 2) / hex.substr(2);
    if (!fs::exists(loose)) fail("missing object " + hex);
    const Bytes compressed = read_file(loose.string());
    const Bytes inflated = zlib_decompress(bytes_span(compressed));
    const RawHeader header = parse_object_header(bytes_span(inflated));
    GitObject object;
    object.type = git_type_of_name(header.type);
    object.payload = header.payload;
    return objects_.emplace(key, std::move(object)).first->second;
  }

  bool has(const GitIdKey& key) {
    if (objects_.count(key) != 0) return true;
    if (key.size() != 20) return false;
    const std::string hex = to_hex(ByteSpan(reinterpret_cast<const uint8_t*>(key.data()), 20));
    return fs::exists(objects_dir_ / hex.substr(0, 2) / hex.substr(2));
  }

 private:
  fs::path objects_dir_;
  std::unordered_map<GitIdKey, GitObject> objects_;
};

std::vector<GitId> object_children(const GitObject& object) {
  std::vector<GitId> children;
  const std::string_view text = bytes_view(bytes_span(object.payload));
  if (object.type == 1) {
    std::size_t pos = 0;
    while (pos < text.size()) {
      const std::size_t line_end = text.find('\n', pos);
      const std::string_view line =
          text.substr(pos, line_end == std::string_view::npos ? std::string_view::npos
                                                             : line_end - pos);
      if (line.empty()) break;
      if (line.size() > 5 && line.substr(0, 5) == "tree ") {
        children.push_back(parse_hex_id(line.substr(5)));
      } else if (line.size() > 7 && line.substr(0, 7) == "parent ") {
        children.push_back(parse_hex_id(line.substr(7)));
      }
      if (line_end == std::string_view::npos) break;
      pos = line_end + 1;
    }
  } else if (object.type == 2) {
    std::size_t pos = 0;
    while (pos < object.payload.size()) {
      const std::size_t space = object.payload.find(' ', pos);
      if (space == std::string::npos) fail("bad tree entry");
      const std::size_t nul = object.payload.find('\0', space + 1);
      if (nul == std::string::npos) fail("bad tree entry name");
      if (nul + 1 + 20 > object.payload.size()) fail("truncated tree entry id");
      GitId id{};
      std::memcpy(id.data(), object.payload.data() + nul + 1, 20);
      children.push_back(id);
      pos = nul + 1 + 20;
    }
  } else if (object.type == 4) {
    std::size_t pos = 0;
    while (pos < text.size()) {
      const std::size_t line_end = text.find('\n', pos);
      const std::string_view line =
          text.substr(pos, line_end == std::string_view::npos ? std::string_view::npos
                                                             : line_end - pos);
      if (line.empty()) break;
      if (line.size() > 7 && line.substr(0, 7) == "object ") {
        children.push_back(parse_hex_id(line.substr(7)));
      }
      if (line_end == std::string_view::npos) break;
      pos = line_end + 1;
    }
  }
  return children;
}

struct GitTreeEntry {
  std::string mode;
  std::string name;
  GitId id{};
};

std::vector<GitTreeEntry> parse_git_tree(const Bytes& payload) {
  std::vector<GitTreeEntry> entries;
  std::size_t pos = 0;
  while (pos < payload.size()) {
    const std::size_t space = payload.find(' ', pos);
    if (space == std::string::npos) fail("bad tree entry");
    const std::size_t nul = payload.find('\0', space + 1);
    if (nul == std::string::npos) fail("bad tree entry name");
    if (nul + 1 + 20 > payload.size()) fail("truncated tree entry id");
    GitTreeEntry entry;
    entry.mode = payload.substr(pos, space - pos);
    entry.name = payload.substr(space + 1, nul - space - 1);
    std::memcpy(entry.id.data(), payload.data() + nul + 1, 20);
    entries.push_back(std::move(entry));
    pos = nul + 1 + 20;
  }
  return entries;
}

std::vector<std::pair<std::string, std::string>> header_lines(const Bytes& payload) {
  std::vector<std::pair<std::string, std::string>> headers;
  std::size_t pos = 0;
  while (pos < payload.size()) {
    const std::size_t line_end = payload.find('\n', pos);
    if (line_end == std::string::npos) break;
    const std::string line = payload.substr(pos, line_end - pos);
    if (line.empty()) break;
    if (line[0] != ' ') {
      const std::size_t space = line.find(' ');
      if (space != std::string::npos) {
        headers.emplace_back(line.substr(0, space), line.substr(space + 1));
      }
    }
    pos = line_end + 1;
  }
  return headers;
}

Bytes object_body(const Bytes& payload) {
  const std::size_t blank = payload.find("\n\n");
  if (blank == std::string::npos) return Bytes();
  return payload.substr(blank + 2);
}

int64_t parse_timestamp(std::string_view line) {
  // "<identity> <seconds> <timezone>": read the last two space-separated fields.
  const std::size_t tz_space = line.rfind(' ');
  if (tz_space == std::string_view::npos) fail("bad timestamp line");
  const std::string_view before_tz = line.substr(0, tz_space);
  const std::size_t ts_space = before_tz.rfind(' ');
  if (ts_space == std::string_view::npos) fail("bad timestamp line");
  try {
    return std::stoll(std::string(before_tz.substr(ts_space + 1)));
  } catch (const std::exception&) {
    fail("bad timestamp");
  }
}

std::string parse_timezone(std::string_view line) {
  const std::size_t tz_space = line.rfind(' ');
  if (tz_space == std::string_view::npos) fail("bad timestamp line");
  return std::string(line.substr(tz_space + 1));
}

std::map<std::string, std::string> read_git_refs(const fs::path& git_dir) {
  std::map<std::string, std::string> refs;
  const fs::path packed = git_dir / "packed-refs";
  if (fs::exists(packed)) {
    std::ifstream in(packed, std::ios::binary);
    std::string line;
    while (std::getline(in, line)) {
      if (line.empty() || line[0] == '#' || line[0] == '^') continue;
      const std::size_t space = line.find(' ');
      if (space == std::string::npos) continue;
      refs[line.substr(space + 1)] = line.substr(0, space);
    }
  }
  const fs::path refs_dir = git_dir / "refs";
  if (fs::exists(refs_dir)) {
    for (const auto& entry : fs::recursive_directory_iterator(refs_dir)) {
      if (!entry.is_regular_file()) continue;
      const std::string relative = fs::relative(entry.path(), git_dir).generic_string();
      refs[relative] = trim_copy(read_text_file(entry.path()));
    }
  }
  return refs;
}

GitImportStats import_objects(Repo& repo, const fs::path& git_dir,
                              const std::map<std::string, std::string>& refs,
                              const std::optional<std::string>& head_ref,
                              const std::optional<std::string>& head_commit_hex) {
  GitObjectSource source(git_dir / "objects");

  std::vector<GitIdKey> tips;
  for (const auto& [name, hex] : refs) {
    (void)name;
    if (hex.size() < 40) continue;
    try {
      tips.push_back(key_of(parse_hex_id(hex)));
    } catch (const std::exception&) {
      // Ignore malformed refs; HEAD may also name a branch that does not exist.
    }
  }
  // A detached git HEAD is not a ref; it must still be imported.
  if (head_commit_hex.has_value()) {
    try {
      tips.push_back(key_of(parse_hex_id(*head_commit_hex)));
    } catch (const std::exception&) {
      // Malformed HEAD: keep importing the refs that were readable.
    }
  }
  std::vector<GitIdKey> order;
  std::unordered_set<GitIdKey> visited;
  std::vector<std::pair<GitIdKey, int>> stack;
  for (const GitIdKey& tip : tips) stack.emplace_back(tip, 0);
  while (!stack.empty()) {
    auto [key, phase] = stack.back();
    stack.pop_back();
    if (phase == 1) {
      order.push_back(key);
      continue;
    }
    if (!visited.insert(key).second) continue;
    stack.emplace_back(key, 1);
    const GitObject& object = source.get(key);
    const std::vector<GitId> children = object_children(object);
    for (const GitId& child : children) stack.emplace_back(key_of(child), 0);
  }

  std::unordered_map<GitIdKey, std::string> iaqs_ids;
  GitImportStats stats;
  repo.database().begin();
  try {
    for (const GitIdKey& key : order) {
      const GitObject& object = source.get(key);
      std::string oid;
      switch (object.type) {
        case 3: {
          oid = repo.objects().write(ObjType::Blob, object.payload);
          ++stats.blobs;
          break;
        }
        case 2: {
          std::vector<TreeEntry> entries;
          for (const GitTreeEntry& git_entry : parse_git_tree(object.payload)) {
            TreeEntry entry;
            entry.name = git_entry.name;
            const auto child = iaqs_ids.find(key_of(git_entry.id));
            if (child == iaqs_ids.end()) fail("tree child was not converted first");
            entry.oid = child->second;
            const std::string& mode = git_entry.mode;
            if (mode == "40000") {
              entry.mode = vcs::kModeDir;
              entry.type = ObjType::Tree;
            } else if (mode == "100755") {
              entry.mode = vcs::kModeExec;
              entry.type = ObjType::Blob;
            } else if (mode == "120000") {
              entry.mode = vcs::kModeSymlink;
              entry.type = ObjType::Blob;
            } else if (mode == "160000") {
              fail("submodule entries are not supported");
            } else {
              entry.mode = vcs::kModeFile;
              entry.type = ObjType::Blob;
            }
            entries.push_back(std::move(entry));
          }
          oid = repo.objects().write(ObjType::Tree, vcs::encode_tree(entries));
          ++stats.trees;
          break;
        }
        case 1: {
          Commit commit;
          int64_t time = 0;
          std::string tz = "+0000";
          for (const auto& [name, value] : header_lines(object.payload)) {
            if (name == "tree") {
              const auto child = iaqs_ids.find(key_of(parse_hex_id(value)));
              if (child == iaqs_ids.end()) fail("commit tree was not converted first");
              commit.tree = child->second;
            } else if (name == "parent") {
              const auto child = iaqs_ids.find(key_of(parse_hex_id(value)));
              if (child == iaqs_ids.end()) fail("commit parent was not converted first");
              commit.parents.push_back(child->second);
            } else if (name == "committer") {
              time = parse_timestamp(value);
              tz = parse_timezone(value);
            }
          }
          commit.time = time;
          commit.tz = tz;
          commit.message = object_body(object.payload);
          oid = repo.write_commit(commit);
          ++stats.commits;
          break;
        }
        case 4: {
          Tag tag;
          int64_t time = 0;
          std::string tz = "+0000";
          for (const auto& [name, value] : header_lines(object.payload)) {
            if (name == "object") {
              const auto child = iaqs_ids.find(key_of(parse_hex_id(value)));
              if (child == iaqs_ids.end()) fail("tag target was not converted first");
              tag.object = child->second;
            } else if (name == "type") {
              tag.type = vcs::type_from_name(value);
            } else if (name == "tag") {
              tag.name = value;
            } else if (name == "tagger") {
              time = parse_timestamp(value);
              tz = parse_timezone(value);
            }
          }
          tag.time = time;
          tag.tz = tz;
          tag.message = object_body(object.payload);
          oid = repo.objects().write(ObjType::Tag, vcs::encode_tag(tag));
          ++stats.tags;
          break;
        }
        default:
          fail("unsupported object type");
      }
      iaqs_ids.emplace(key, oid);
    }

    for (const auto& [name, hex] : refs) {
      if (hex.size() < 40) continue;
      const auto found = iaqs_ids.find(key_of(parse_hex_id(hex)));
      if (found == iaqs_ids.end()) continue;
      repo.update_ref(name, found->second, "import-git");
      ++stats.refs;
    }
    if (head_ref.has_value() && refs.count(*head_ref) != 0) {
      repo.set_head_symbolic(*head_ref);
    } else if (head_commit_hex.has_value()) {
      try {
        const auto found = iaqs_ids.find(key_of(parse_hex_id(*head_commit_hex)));
        if (found != iaqs_ids.end()) repo.set_head_detached(found->second);
      } catch (const std::exception&) {
        // Malformed detached HEAD: leave the repository without a checkout.
      }
    }
    repo.database().commit();
  } catch (...) {
    repo.database().rollback();
    throw;
  }
  // Materialise the imported tip so the working tree is usable immediately.
  if (repo.head_oid().has_value()) repo.checkout_commit("HEAD", true);
  // checkout_commit resolves "HEAD" to a raw commit and detaches; restore the
  // branch the imported repository was on.
  if (head_ref.has_value() && repo.ref_oid(*head_ref).has_value()) {
    repo.set_head_symbolic(*head_ref);
  }
  return stats;
}

}  // namespace

PackExportStats export_git_packs(Repo& repo, const PackExportOptions& options) {
  return export_packs(repo, options);
}

GitImportStats import_git_dir(Repo& repo, const std::filesystem::path& git_dir,
                              const GitImportOptions& options) {
  fs::path root = git_dir;
  if (root.filename() != ".git") {
    const fs::path nested = root / ".git";
    if (fs::exists(nested)) root = nested;
  }
  if (!fs::exists(root / "HEAD")) fail("not a git directory: " + root.string());
  if (!options.force) {
    if (!repo.list_refs().empty() || repo.head_oid().has_value()) {
      fail("destination repository is not empty (use --force)");
    }
  }
  std::optional<std::string> head_ref;
  std::optional<std::string> head_commit_hex;
  const std::string head = trim_copy(read_text_file(root / "HEAD"));
  if (head.rfind("ref: ", 0) == 0) {
    head_ref = trim_copy(head.substr(5));
  } else if (head.size() == 40) {
    head_commit_hex = head;  // detached checkout
  }
  const std::map<std::string, std::string> refs = read_git_refs(root);
  return import_objects(repo, root, refs, head_ref, head_commit_hex);
}

}  // namespace iaqs::git
