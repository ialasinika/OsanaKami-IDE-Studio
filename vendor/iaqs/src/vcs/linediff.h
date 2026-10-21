// Line-based diff primitive shared by the merge engine and diff output.
#pragma once

#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

namespace iaqs::vcs {

// One changed region of the base text: base lines [start, end) are replaced by
// `lines`. A pure insertion has start == end; a pure deletion has empty lines.
struct LineChange {
  std::size_t start = 0;
  std::size_t end = 0;
  std::vector<std::string> lines;
};

// Splits text into lines while keeping the trailing '\n' (missing for the last
// line when the text does not end with one).
std::vector<std::string> split_lines(std::string_view text);

// Myers diff: returns the edits that transform `a` into `b`.
std::vector<LineChange> diff_changes(const std::vector<std::string>& a,
                                     const std::vector<std::string>& b);

}  // namespace iaqs::vcs
