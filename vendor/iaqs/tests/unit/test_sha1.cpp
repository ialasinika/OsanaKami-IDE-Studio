#include <string>
#include <string_view>

#include "core/util.h"
#include "git/sha1.h"
#include "harness.h"

using namespace iaqs;
using namespace iaqs::git;

IAQS_TEST(git_sha1, known_vectors) {
  CHECK_EQ(sha1_hex(std::string_view{}), std::string("da39a3ee5e6b4b0d3255bfef95601890afd80709"));
  CHECK_EQ(sha1_hex(std::string_view("abc")),
           std::string("a9993e364706816aba3e25717850c26c9cd0d89d"));
  CHECK_EQ(sha1_hex(std::string_view("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
           std::string("84983e441c3bd26ebaae4aa1f95129e5e54670f1"));
}

IAQS_TEST(git_sha1, chunked_update_matches_one_shot) {
  const std::string message = "The quick brown fox jumps over the lazy dog";
  Sha1 chunked;
  chunked.update(std::string_view(message).substr(0, 10));
  chunked.update(std::string_view(message).substr(10));
  const std::array<uint8_t, 20> first = chunked.finish();
  const std::array<uint8_t, 20> second = sha1(ByteSpan(reinterpret_cast<const uint8_t*>(message.data()),
                                                       message.size()));
  CHECK(first == second);
}

IAQS_TEST(git_sha1, git_object_ids_use_type_and_size_header) {
  const auto id = git_object_id("blob", bytes_span(std::string_view("hello")));
  CHECK_EQ(sha1_hex(id), std::string("b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0"));
  const auto empty = git_object_id("blob", bytes_span(std::string_view{}));
  CHECK_EQ(sha1_hex(empty), std::string("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"));
}
