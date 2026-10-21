#include "vcs/objects.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <stdexcept>

#include "crypto/sha256.h"

namespace iaqs::vcs {
namespace {

[[noreturn]] void fail(const std::string& what) {
  throw std::runtime_error("object: " + what);
}

std::string oct_mode(uint32_t mode) {
  char buf[16];
  std::snprintf(buf, sizeof(buf), "%07o", mode & 0777777u);
  return std::string(buf);
}

uint32_t parse_mode(std::string_view text) {
  uint32_t value = 0;
  for (char c : text) {
    if (c < '0' || c > '7') fail("bad tree mode '" + std::string(text) + "'");
    value = value * 8 + static_cast<uint32_t>(c - '0');
  }
  return value;
}

}  // namespace

std::string_view type_name(ObjType type) {
  switch (type) {
    case ObjType::Blob: return "blob";
    case ObjType::Tree: return "tree";
    case ObjType::Commit: return "commit";
    case ObjType::Tag: return "tag";
  }
  fail("unknown object type");
}

const char* type_name_cstr(ObjType type) {
  const std::string_view name = type_name(type);
  switch (type) {
    case ObjType::Blob: return "blob";
    case ObjType::Tree: return "tree";
    case ObjType::Commit: return "commit";
    case ObjType::Tag: return "tag";
  }
  (void)name;
  return "blob";
}

ObjType type_from_name(std::string_view name) {
  if (name == "blob") return ObjType::Blob;
  if (name == "tree") return ObjType::Tree;
  if (name == "commit") return ObjType::Commit;
  if (name == "tag") return ObjType::Tag;
  fail("unknown type name '" + std::string(name) + "'");
}

uint32_t canonical_mode(uint32_t mode) {
  if (mode == kModeExec) return kModeExec;
  if (mode == kModeSymlink) return kModeSymlink;
  if (mode == kModeDir) return kModeDir;
  return kModeFile;
}

std::string escape_name(std::string_view name) {
  std::string out;
  out.reserve(name.size());
  for (char c : name) {
    switch (c) {
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default: out += c; break;
    }
  }
  return out;
}

std::string unescape_name(std::string_view escaped) {
  std::string out;
  out.reserve(escaped.size());
  for (size_t i = 0; i < escaped.size(); ++i) {
    const char c = escaped[i];
    if (c != '\\') {
      out += c;
      continue;
    }
    if (i + 1 >= escaped.size()) fail("dangling backslash in name");
    const char next = escaped[++i];
    switch (next) {
      case '\\': out += '\\'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      default:
        fail(std::string("bad escape '\\") + next + "' in name");
    }
  }
  return out;
}

std::string frame(ObjType type, std::string_view payload) {
  std::string out;
  const std::string_view name = type_name(type);
  out.reserve(name.size() + 24 + payload.size());
  out.append(name);
  out += ' ';
  out += std::to_string(payload.size());
  out += '\0';
  out.append(payload);
  return out;
}

std::string object_id(ObjType type, std::string_view payload) {
  return sha256_hex(frame(type, payload));
}

std::string encode_tree(const std::vector<TreeEntry>& entries) {
  std::vector<const TreeEntry*> sorted;
  sorted.reserve(entries.size());
  for (const auto& entry : entries) sorted.push_back(&entry);
  std::sort(sorted.begin(), sorted.end(),
            [](const TreeEntry* a, const TreeEntry* b) { return a->name < b->name; });

  std::string out;
  std::string previous_name;
  for (const TreeEntry* entry : sorted) {
    if (entry->name.empty() || entry->name == "." || entry->name == "..") {
      fail("invalid tree entry name");
    }
    if (!previous_name.empty() && entry->name == previous_name) {
      fail("duplicate tree entry name: " + entry->name);
    }
    previous_name = entry->name;
    if (entry->oid.size() != 64) fail("tree entry oid must be 64 hex chars");
    if (entry->type == ObjType::Blob && entry->mode == kModeDir) fail("file entry with dir mode");
    if (entry->type == ObjType::Tree && entry->mode != kModeDir) fail("tree entry without dir mode");
    out += oct_mode(entry->mode);
    out += ' ';
    out += type_name(entry->type);
    out += ' ';
    out += entry->oid;
    out += ' ';
    out += escape_name(entry->name);
    out += '\n';
  }
  return out;
}

std::vector<TreeEntry> decode_tree(std::string_view payload) {
  std::vector<TreeEntry> entries;
  size_t pos = 0;
  while (pos < payload.size()) {
    const size_t eol = payload.find('\n', pos);
    if (eol == std::string_view::npos) fail("tree line without newline");
    const std::string_view line = payload.substr(pos, eol - pos);
    pos = eol + 1;

    const size_t sp1 = line.find(' ');
    if (sp1 == std::string_view::npos) fail("tree line missing mode");
    const size_t sp2 = line.find(' ', sp1 + 1);
    if (sp2 == std::string_view::npos) fail("tree line missing type");
    const size_t sp3 = line.find(' ', sp2 + 1);
    if (sp3 == std::string_view::npos) fail("tree line missing oid");

    TreeEntry entry;
    entry.mode = parse_mode(line.substr(0, sp1));
    entry.type = type_from_name(line.substr(sp1 + 1, sp2 - sp1 - 1));
    entry.oid = std::string(line.substr(sp2 + 1, sp3 - sp2 - 1));
    entry.name = unescape_name(line.substr(sp3 + 1));
    if (entry.oid.size() != 64) fail("tree entry oid must be 64 hex chars");
    entries.push_back(std::move(entry));
  }
  return entries;
}

std::string encode_commit(const Commit& commit) {
  if (commit.tree.size() != 64) fail("commit tree oid must be 64 hex chars");
  std::string out;
  out += "tree " + commit.tree + "\n";
  for (const auto& parent : commit.parents) {
    if (parent.size() != 64) fail("commit parent oid must be 64 hex chars");
    out += "parent " + parent + "\n";
  }
  out += "time " + std::to_string(commit.time) + " " + commit.tz + "\n\n";
  out += commit.message;
  if (!commit.message.empty() && commit.message.back() != '\n') out += '\n';
  return out;
}

Commit decode_commit(std::string_view payload) {
  Commit commit;
  size_t pos = 0;
  bool saw_time = false;
  while (pos < payload.size()) {
    const size_t eol = payload.find('\n', pos);
    if (eol == std::string_view::npos) fail("commit line without newline");
    const std::string_view line = payload.substr(pos, eol - pos);
    pos = eol + 1;
    if (line.empty()) {
      commit.message = std::string(payload.substr(pos));
      return commit;
    }
    if (line.substr(0, 5) == "tree ") {
      commit.tree = std::string(line.substr(5));
    } else if (line.substr(0, 7) == "parent ") {
      commit.parents.emplace_back(line.substr(7));
    } else if (line.substr(0, 5) == "time ") {
      const std::string_view rest = line.substr(5);
      const size_t sp = rest.find(' ');
      if (sp == std::string_view::npos) fail("commit time line malformed");
      commit.time = std::strtoll(std::string(rest.substr(0, sp)).c_str(), nullptr, 10);
      commit.tz = std::string(rest.substr(sp + 1));
      saw_time = true;
    } else {
      fail("unknown commit header line");
    }
  }
  if (!saw_time) fail("commit without time");
  commit.message.clear();
  return commit;
}

std::string encode_tag(const Tag& tag) {
  if (tag.object.size() != 64) fail("tag object oid must be 64 hex chars");
  std::string out;
  out += "object " + tag.object + "\n";
  out += "type " + std::string(type_name(tag.type)) + "\n";
  out += "tag " + tag.name + "\n";
  out += "time " + std::to_string(tag.time) + " " + tag.tz + "\n\n";
  out += tag.message;
  if (!tag.message.empty() && tag.message.back() != '\n') out += '\n';
  return out;
}

Tag decode_tag(std::string_view payload) {
  Tag tag;
  size_t pos = 0;
  while (pos < payload.size()) {
    const size_t eol = payload.find('\n', pos);
    if (eol == std::string_view::npos) fail("tag line without newline");
    const std::string_view line = payload.substr(pos, eol - pos);
    pos = eol + 1;
    if (line.empty()) {
      tag.message = std::string(payload.substr(pos));
      return tag;
    }
    if (line.substr(0, 7) == "object ") {
      tag.object = std::string(line.substr(7));
    } else if (line.substr(0, 5) == "type ") {
      tag.type = type_from_name(line.substr(5));
    } else if (line.substr(0, 4) == "tag ") {
      tag.name = std::string(line.substr(4));
    } else if (line.substr(0, 5) == "time ") {
      const std::string_view rest = line.substr(5);
      const size_t sp = rest.find(' ');
      if (sp == std::string_view::npos) fail("tag time line malformed");
      tag.time = std::strtoll(std::string(rest.substr(0, sp)).c_str(), nullptr, 10);
      tag.tz = std::string(rest.substr(sp + 1));
    } else {
      fail("unknown tag header line");
    }
  }
  fail("tag without message separator");
}

}  // namespace iaqs::vcs
