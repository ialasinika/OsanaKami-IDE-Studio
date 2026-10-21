#include <string>

#include "harness.h"
#include "vcs/merge.h"

using namespace iaqs;

IAQS_TEST(vcs_merge, identical_inputs_are_clean) {
  const std::string text = "a\nb\nc\n";
  const auto merged = vcs::merge3(text, text, text, "ours", "theirs");
  CHECK(merged.clean);
  CHECK_EQ(merged.content, text);
}

IAQS_TEST(vcs_merge, disjoint_edits_merge_cleanly) {
  const std::string base = "a\nb\nc\nd\n";
  const std::string ours = "a\nB\nc\nd\n";
  const std::string theirs = "a\nb\nc\nD\n";
  const auto merged = vcs::merge3(base, ours, theirs, "ours", "theirs");
  CHECK(merged.clean);
  CHECK_EQ(merged.content, std::string("a\nB\nc\nD\n"));
}

IAQS_TEST(vcs_merge, one_side_only) {
  const std::string base = "one\ntwo\nthree\n";
  const std::string ours = base;
  const std::string theirs = "one\ntwo changed\nthree\nfour\n";
  const auto merged = vcs::merge3(base, ours, theirs, "ours", "theirs");
  CHECK(merged.clean);
  CHECK_EQ(merged.content, theirs);
}

IAQS_TEST(vcs_merge, identical_change_on_both_sides) {
  const std::string base = "a\nb\nc\n";
  const std::string ours = "a\nB\nc\n";
  const std::string theirs = "a\nB\nc\n";
  const auto merged = vcs::merge3(base, ours, theirs, "ours", "theirs");
  CHECK(merged.clean);
  CHECK_EQ(merged.content, std::string("a\nB\nc\n"));
}

IAQS_TEST(vcs_merge, overlapping_edits_conflict) {
  const std::string base = "a\nb\nc\n";
  const std::string ours = "a\nours\nc\n";
  const std::string theirs = "a\ntheirs\nc\n";
  const auto merged = vcs::merge3(base, ours, theirs, "HEAD", "feature");
  CHECK(!merged.clean);
  CHECK_EQ(merged.conflicts, 1u);
  CHECK(merged.content.find("<<<<<<< HEAD\n") != std::string::npos);
  CHECK(merged.content.find("ours\n") != std::string::npos);
  CHECK(merged.content.find("=======\n") != std::string::npos);
  CHECK(merged.content.find(">>>>>>> feature\n") != std::string::npos);
}

IAQS_TEST(vcs_merge, insertions_at_different_places) {
  const std::string base = "a\nc\n";
  const std::string ours = "a\nb\nc\n";
  const std::string theirs = "a\nc\nd\n";
  const auto merged = vcs::merge3(base, ours, theirs, "ours", "theirs");
  CHECK(merged.clean);
  CHECK_EQ(merged.content, std::string("a\nb\nc\nd\n"));
}

IAQS_TEST(vcs_merge, deletion_vs_untouched) {
  const std::string base = "a\nb\nc\n";
  const std::string ours = "a\nc\n";
  const std::string theirs = "a\nb\nc\n";
  const auto merged = vcs::merge3(base, ours, theirs, "ours", "theirs");
  CHECK(merged.clean);
  CHECK_EQ(merged.content, std::string("a\nc\n"));
}

IAQS_TEST(vcs_merge, handles_missing_trailing_newline) {
  const std::string base = "a\nb";
  const std::string ours = "A\nb";
  const std::string theirs = "a\nB";
  const auto merged = vcs::merge3(base, ours, theirs, "ours", "theirs");
  CHECK(merged.clean);
  CHECK_EQ(merged.content, std::string("A\nB"));
}
