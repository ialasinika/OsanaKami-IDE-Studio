#include "vcs/objects.h"

#include <string>
#include <vector>

#include "crypto/sha256.h"
#include "harness.h"

using namespace iaqs;

namespace {

using namespace iaqs;

}  // namespace

IAQS_TEST(vcs_objects, object_id_matches_documented_frame) {
  const std::string payload = "hello";
  std::string expected_frame = "blob 5";
  expected_frame.push_back('\0');
  expected_frame += "hello";
  const std::string expected = sha256_hex(expected_frame);
  CHECK_EQ(vcs::object_id(vcs::ObjType::Blob, payload), expected);
}

IAQS_TEST(vcs_objects, tree_roundtrip_sorts_and_escapes_names) {
  std::vector<vcs::TreeEntry> entries;
  entries.push_back({vcs::kModeFile, vcs::ObjType::Blob, std::string(64, 'a'), "b.txt"});
  entries.push_back({vcs::kModeFile, vcs::ObjType::Blob, std::string(64, 'b'), "a.txt"});
  entries.push_back({vcs::kModeDir, vcs::ObjType::Tree, std::string(64, 'c'), "dir"});
  entries.push_back({vcs::kModeFile, vcs::ObjType::Blob, std::string(64, 'd'), "space name"});
  entries.push_back({vcs::kModeFile, vcs::ObjType::Blob, std::string(64, 'e'), "tab\tname\nline"});

  const Bytes encoded = vcs::encode_tree(entries);
  const auto decoded = vcs::decode_tree(encoded);
  CHECK_EQ(decoded.size(), entries.size());
  CHECK_EQ(decoded[0].name, std::string("a.txt"));
  CHECK_EQ(decoded[1].name, std::string("b.txt"));
  CHECK_EQ(decoded[2].name, std::string("dir"));
  CHECK_EQ(decoded[3].name, std::string("space name"));
  CHECK_EQ(decoded[4].name, std::string("tab\tname\nline"));
  // Names use '/' only as a separator, so the escaped newline must stay on one line.
  CHECK(encoded.find("tab\\tname\\nline") != std::string::npos);
}

IAQS_TEST(vcs_objects, tree_rejects_duplicate_entries) {
  std::vector<vcs::TreeEntry> entries;
  entries.push_back({vcs::kModeFile, vcs::ObjType::Blob, std::string(64, 'a'), "same"});
  entries.push_back({vcs::kModeFile, vcs::ObjType::Blob, std::string(64, 'b'), "same"});
  CHECK_THROW(vcs::encode_tree(entries), std::runtime_error);
}

IAQS_TEST(vcs_objects, commit_roundtrip_has_no_author) {
  vcs::Commit commit;
  commit.tree = std::string(64, 'f');
  commit.parents = {std::string(64, '1'), std::string(64, '2')};
  commit.time = 1700000000;
  commit.tz = "+0800";
  commit.message = "subject\n\nbody line\n";

  const Bytes encoded = vcs::encode_commit(commit);
  CHECK(encoded.find("author") == std::string::npos);
  CHECK(encoded.find("tree ") == 0);
  const vcs::Commit decoded = vcs::decode_commit(encoded);
  CHECK_EQ(decoded.tree, commit.tree);
  CHECK_EQ(decoded.parents.size(), 2u);
  CHECK_EQ(decoded.parents[1], commit.parents[1]);
  CHECK_EQ(decoded.time, commit.time);
  CHECK_EQ(decoded.tz, commit.tz);
  CHECK_EQ(decoded.message, commit.message);
}

IAQS_TEST(vcs_objects, commit_rejects_short_oid) {
  vcs::Commit commit;
  commit.tree = "abc";
  commit.time = 1;
  commit.tz = "+0000";
  commit.message = "x";
  CHECK_THROW(vcs::encode_commit(commit), std::runtime_error);
}

IAQS_TEST(vcs_objects, tag_roundtrip) {
  vcs::Tag tag;
  tag.object = std::string(64, 'a');
  tag.type = vcs::ObjType::Commit;
  tag.name = "v1.0";
  tag.time = 1700000000;
  tag.tz = "+0800";
  tag.message = "release\n";
  const vcs::Tag decoded = vcs::decode_tag(vcs::encode_tag(tag));
  CHECK_EQ(decoded.object, tag.object);
  CHECK_EQ(decoded.name, tag.name);
  CHECK_EQ(decoded.type, vcs::ObjType::Commit);
  CHECK_EQ(decoded.message, tag.message);
}
