#include <string>

#include "harness.h"
#include "vcs/diff.h"

using namespace iaqs;

IAQS_TEST(diff, identical_text_is_empty) {
  CHECK_EQ(vcs::unified_diff("a\nb\n", "a\nb\n", "a/x", "b/x"), std::string());
}

IAQS_TEST(diff, changed_line_renders_minus_and_plus) {
  const std::string diff =
      vcs::unified_diff("one\ntwo\nthree\n", "one\nTWO\nthree\n", "a/x", "b/x");
  CHECK(diff.find("--- a/x\n") == 0);
  CHECK(diff.find("+++ b/x\n") != std::string::npos);
  CHECK(diff.find("@@ -1,3 +1,3 @@") != std::string::npos);
  CHECK(diff.find("-two\n") != std::string::npos);
  CHECK(diff.find("+TWO\n") != std::string::npos);
  CHECK(diff.find(" one\n") != std::string::npos);
}

IAQS_TEST(diff, insertion_and_deletion) {
  const std::string inserted =
      vcs::unified_diff("a\nb\n", "a\nx\nb\n", "a/x", "b/x");
  CHECK(inserted.find("+x\n") != std::string::npos);
  CHECK(inserted.find("-") == std::string::npos ||
        inserted.find("\n-") == std::string::npos);

  const std::string deleted =
      vcs::unified_diff("a\nx\nb\n", "a\nb\n", "a/x", "b/x");
  CHECK(deleted.find("-x\n") != std::string::npos);
}

IAQS_TEST(diff, missing_trailing_newline_is_marked) {
  const std::string diff = vcs::unified_diff("one", "two", "a/x", "b/x");
  CHECK(diff.find("\\ No newline at end of file\n") != std::string::npos);
}

IAQS_TEST(diff, binary_detection) {
  CHECK(vcs::looks_binary(std::string("\x00\x01\x02", 3)));
  CHECK(!vcs::looks_binary(std::string("plain text\n")));
  CHECK(!vcs::looks_binary(std::string(9000, 'a')));
}
