#include <array>
#include <cstdio>
#include <filesystem>
#include <random>
#include <string>
#include <vector>

#include "core/util.h"
#include "git/pack.h"
#include "git/sha1.h"
#include "harness.h"

using namespace iaqs;
using namespace iaqs::git;

namespace {

namespace fs = std::filesystem;

struct TempDir {
  fs::path path;
  TempDir() {
    std::random_device rd;
    char suffix[32];
    std::snprintf(suffix, sizeof(suffix), "iaqs-pack-%08x", rd());
    path = fs::temp_directory_path() / suffix;
    fs::create_directories(path);
  }
  ~TempDir() {
    std::error_code ec;
    fs::remove_all(path, ec);
  }
};

std::string hex_of(const std::array<uint8_t, 20>& id) {
  return to_hex(ByteSpan(id.data(), id.size()));
}

void put_varint(Bytes& out, uint64_t value) {
  while (value >= 0x80) {
    out.push_back(static_cast<char>((value & 0x7F) | 0x80));
    value >>= 7;
  }
  out.push_back(static_cast<char>(value));
}

}  // namespace

IAQS_TEST(git_pack, write_and_read_roundtrip) {
  TempDir dir;
  const std::string blob_text = "hello\n";
  const std::string tree_text = "sub\n";
  const PackObject blob1{3, git_object_id("blob", bytes_span(blob_text)), Bytes(blob_text)};
  const PackObject blob2{3, git_object_id("blob", bytes_span(tree_text)), Bytes(tree_text)};

  Bytes tree_payload;
  tree_payload.append("100644 a.txt");
  tree_payload.push_back('\0');
  tree_payload.append(reinterpret_cast<const char*>(blob1.id.data()), 20);
  const PackObject tree{2, git_object_id("tree", bytes_span(tree_payload)), tree_payload};

  const std::string commit_text =
      "tree " + hex_of(tree.id) +
      "\nauthor T <t@example.com> 1700000000 +0000\n"
      "committer T <t@example.com> 1700000000 +0000\n\nfirst\n";
  const PackObject commit{1, git_object_id("commit", bytes_span(commit_text)), Bytes(commit_text)};

  const std::vector<PackObject> objects = {blob1, blob2, tree, commit};
  const fs::path prefix = dir.path / "pack";
  const std::string checksum = git::write_pack(prefix, objects);
  CHECK(fs::exists(prefix.string() + ".pack"));
  CHECK(fs::exists(prefix.string() + ".idx"));

  const git::PackFile file =
      git::read_pack(prefix.string() + ".pack", prefix.string() + ".idx");
  CHECK_EQ(file.objects.size(), 4u);
  CHECK_EQ(hex_of(file.checksum), checksum);
  CHECK_EQ(file.entries.size(), 4u);
  for (const PackObject& original : objects) {
    bool found = false;
    for (const PackObject& read : file.objects) {
      if (read.id == original.id) {
        found = true;
        CHECK_EQ(read.type, original.type);
        CHECK_EQ(read.payload, original.payload);
        break;
      }
    }
    CHECK(found);
  }

  const git::PackIndex index = git::read_pack_index(prefix.string() + ".idx");
  CHECK_EQ(index.ids.size(), 4u);
  CHECK_EQ(index.offsets.size(), 4u);
  CHECK_EQ(hex_of(index.pack_checksum), checksum);
  for (std::size_t i = 0; i < index.ids.size(); ++i) CHECK(index.offsets[i] > 0);
}

IAQS_TEST(git_pack, checksum_corruption_is_detected) {
  TempDir dir;
  const PackObject blob{3, git_object_id("blob", bytes_span(std::string_view("payload"))),
                        Bytes("payload")};
  const fs::path prefix = dir.path / "pack";
  (void)git::write_pack(prefix, {blob});
  Bytes bytes = read_file(prefix.string() + ".pack");
  bytes[bytes.size() / 2] = static_cast<char>(bytes[bytes.size() / 2] ^ 0x40);
  write_file(prefix.string() + ".pack", bytes_span(bytes));
  CHECK_THROW(git::read_pack(prefix.string() + ".pack", prefix.string() + ".idx"),
              std::runtime_error);
}

IAQS_TEST(git_pack, apply_git_delta_copy_and_insert) {
  const std::string base = "hello";
  Bytes delta;
  put_varint(delta, base.size());
  put_varint(delta, 10);
  delta.push_back(static_cast<char>(0x80 | 0x10));  // copy, size byte 1
  delta.push_back(static_cast<char>(5));
  delta.push_back(static_cast<char>(5));  // insert 5 bytes
  delta.append("world");
  const Bytes result = git::apply_git_delta(bytes_span(base), bytes_span(delta));
  CHECK_EQ(std::string(result), std::string("helloworld"));

  Bytes offset_delta;
  put_varint(offset_delta, 6);
  put_varint(offset_delta, 3);
  offset_delta.push_back(static_cast<char>(0x80 | 0x01 | 0x10));  // offset + size
  offset_delta.push_back(static_cast<char>(1));
  offset_delta.push_back(static_cast<char>(3));
  const Bytes slice = git::apply_git_delta(bytes_span(std::string_view("abcdef")),
                                           bytes_span(offset_delta));
  CHECK_EQ(std::string(slice), std::string("bcd"));
}

IAQS_TEST(git_pack, malformed_entries_are_rejected) {
  const std::string base = "abc";
  Bytes delta;
  put_varint(delta, base.size());
  put_varint(delta, 2);
  delta.push_back(static_cast<char>(0x80 | 0x10));  // copy 256 bytes from a 3-byte base
  delta.push_back(static_cast<char>(0));
  CHECK_THROW(git::apply_git_delta(bytes_span(base), bytes_span(delta)), std::runtime_error);
  CHECK_THROW(git::apply_git_delta(bytes_span(base), ByteSpan()), std::runtime_error);
}
